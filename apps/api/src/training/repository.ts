import type { ResolvedTrainingConfig } from "@ampersand/contracts";
import type { PoolClient } from "pg";

import { QUEUED_TRAINING_JOB_PROGRESS_MESSAGE } from "./config";

export type LoadedTrainingSnapshot = {
  id: string;
  storageUri: string;
  contentSha256: string;
  rowCount: number;
};

export type LoadedTrainingJobProgress = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "dead";
  progressPercent: number;
  progressMessage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export async function loadTrainingJobProgress(
  pool: PoolClient,
  jobId: string,
): Promise<LoadedTrainingJobProgress | null> {
  const result = await pool.query<{
    id: string;
    status: LoadedTrainingJobProgress["status"];
    progress_percent: number;
    progress_message: string | null;
    error_code: string | null;
    error_message: string | null;
  }>(
    `SELECT id, status, progress_percent, progress_message, error_code, error_message
     FROM training_jobs
     WHERE id = $1 AND is_active = true`,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    progressPercent: row.progress_percent,
    progressMessage: row.progress_message,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export async function loadLatestValidSnapshot(
  pool: PoolClient,
  definitionId: string,
): Promise<LoadedTrainingSnapshot | null> {
  const result = await pool.query<{
    id: string;
    storage_uri: string;
    content_sha256: string;
    row_count: string;
  }>(
    `SELECT id, storage_uri, content_sha256, row_count
     FROM dataset_snapshots
     WHERE dataset_definition_id = $1 AND is_active = true
     ORDER BY frozen_at DESC, id DESC
     LIMIT 1`,
    [definitionId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    storageUri: row.storage_uri,
    contentSha256: row.content_sha256,
    rowCount: Number(row.row_count),
  };
}

export async function lockTrainingSubmissionQuota(
  pool: PoolClient,
  schemaName: string,
): Promise<void> {
  await pool.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [schemaName],
  );
}

export async function countActiveTrainingJobs(
  pool: PoolClient,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count
     FROM training_jobs
     WHERE is_active = true AND status IN ('queued', 'running')`,
  );

  return Number(result.rows[0]?.count ?? 0);
}

export async function hasBlockingTrainingFingerprint(
  pool: PoolClient,
  fingerprint: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
     FROM training_jobs
     WHERE fingerprint = $1
       AND is_active = true
       AND status IN ('queued', 'running', 'succeeded')
     LIMIT 1`,
    [fingerprint],
  );

  return result.rowCount === 1;
}

export type InsertTrainingJobInput = {
  datasetSnapshotId: string;
  fingerprint: string;
  trainingConfig: ResolvedTrainingConfig;
  maxRuntimeSeconds: number;
  createdBy: string;
};

export type InsertedTrainingJob = {
  id: string;
  queuedAt: Date;
};

const TRAINING_JOB_INSERT_SAVEPOINT = "training_job_insert";

export async function insertTrainingJob(
  pool: PoolClient,
  input: InsertTrainingJobInput,
): Promise<InsertedTrainingJob> {
  try {
    await pool.query(`SAVEPOINT ${TRAINING_JOB_INSERT_SAVEPOINT}`);

    const result = await pool.query<{ id: string; queued_at: Date }>(
      `INSERT INTO training_jobs
         (dataset_snapshot_id, fingerprint, status, training_config,
          progress_percent, progress_message, queued_at, max_runtime_seconds, created_by, updated_by)
       VALUES ($1, $2, 'queued', $3, 0, $6, now(), $4, $5, $5)
       RETURNING id, queued_at`,
      [
        input.datasetSnapshotId,
        input.fingerprint,
        JSON.stringify(input.trainingConfig),
        input.maxRuntimeSeconds,
        input.createdBy,
        QUEUED_TRAINING_JOB_PROGRESS_MESSAGE,
      ],
    );

    await pool.query(`RELEASE SAVEPOINT ${TRAINING_JOB_INSERT_SAVEPOINT}`);

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to create a training job");
    }

    return { id: row.id, queuedAt: row.queued_at };
  } catch (error) {
    await pool
      .query(`ROLLBACK TO SAVEPOINT ${TRAINING_JOB_INSERT_SAVEPOINT}`)
      .catch(() => {});
    await pool
      .query(`RELEASE SAVEPOINT ${TRAINING_JOB_INSERT_SAVEPOINT}`)
      .catch(() => {});
    throw error;
  }
}

export type CancelTrainingJobOutcome =
  | { ok: true; fromStatus: "queued" | "running" }
  | {
      ok: false;
      reason: "not-found" | "terminal";
      currentStatus: string | null;
    };

const CANCEL_TRAINING_JOB_SQL = `
    WITH target AS (
      SELECT id, status
      FROM training_jobs
      WHERE id = $1 AND status IN ('queued', 'running')
      FOR NO KEY UPDATE
    )
    UPDATE training_jobs tj
    SET status = 'cancelled',
        finished_at = now(),
        updated_at = now()
    FROM target
    WHERE tj.id = target.id
    RETURNING target.status AS from_status
`;

const TRAINING_JOB_STATUS_SQL =
  "SELECT status FROM training_jobs WHERE id = $1";

export async function cancelTrainingJob(
  pool: PoolClient,
  jobId: string,
): Promise<CancelTrainingJobOutcome> {
  const updated = await pool.query<{
    from_status: "queued" | "running";
  }>(CANCEL_TRAINING_JOB_SQL, [jobId]);

  const cancelled = updated.rows[0];
  if (cancelled) {
    return { ok: true, fromStatus: cancelled.from_status };
  }

  const lookup = await pool.query<{ status: string }>(
    TRAINING_JOB_STATUS_SQL,
    [jobId],
  );
  const row = lookup.rows[0];

  if (!row) {
    return { ok: false, reason: "not-found", currentStatus: null };
  }

  return { ok: false, reason: "terminal", currentStatus: row.status };
}

const RECOVER_ABANDONED_JOBS_SQL = `
    UPDATE training_jobs
    SET status = 'dead',
        finished_at = now(),
        updated_at = now(),
        error_code = 'HEARTBEAT_EXPIRED',
        error_message = 'Claim expired without a heartbeat'
    WHERE status = 'running'
      AND heartbeat_at < now()
              - GREATEST(
                  make_interval(secs => $1),
                  make_interval(secs => max_runtime_seconds * 3 / 2)
                )
`;

/**
 * Transitions running jobs whose heartbeat is older than the expiry
 * threshold to ``dead``. The threshold is evaluated per row: at least the
 * configured expiry, but never shorter than one and a half times the
 * job's own runtime bound, so a live worker inside a legitimate long
 * training phase cannot be swept by a tenant-mate's submission. Row-level
 * locks make concurrent sweeps serialize per row; the second sweep
 * re-evaluates the predicate and skips already dead rows.
 */
export async function recoverAbandonedTrainingJobs(
  pool: PoolClient,
  expirySeconds: number,
): Promise<number> {
  const result = await pool.query(RECOVER_ABANDONED_JOBS_SQL, [
    expirySeconds,
  ]);

  return result.rowCount ?? 0;
}
