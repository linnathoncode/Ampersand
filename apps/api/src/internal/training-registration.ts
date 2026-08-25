import type {
  TrainingWorkerSuccess,
  TrainingWorkerModelFeature,
} from "@ampersand/contracts";
import type { Pool, PoolClient } from "pg";

import {
  assertTenantSchemaName,
  withTenantTransaction,
} from "../database/tenant-transaction";
import {
  buildModelArtifactPath,
  deleteArtifact,
  promoteArtifact,
  resolveTempArtifactPath,
  verifyPromotedArtifact,
  type PromotedArtifact,
} from "./fs";

export const DEFAULT_SUCCESS_MESSAGE_TEMPLATE =
  "Training completed; candidate model version {version} registered";

export type CandidateRegistrationErrorCode =
  | "JOB_OWNERSHIP"
  | "JOB_STATE_CONFLICT"
  | "MODEL_ARTIFACT_PROMOTION_FAILED"
  | "MODEL_ARTIFACT_CHECKSUM_MISMATCH"
  | "MODEL_VERSION_CONFLICT"
  | "MODEL_ARTIFACT_CONTENT_CONFLICT"
  | "MODEL_FEATURE_METADATA_INVALID";

export class CandidateRegistrationError extends Error {
  readonly code: CandidateRegistrationErrorCode;

  constructor(code: CandidateRegistrationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CandidateRegistrationError";
  }
}

export type RegisteredCandidate = {
  modelVersionId: string;
  versionNumber: number;
  storageUri: string;
};

export type PromoteCallback = (
  versionNumber: number,
) => Promise<PromotedArtifact>;

export type RegisterCandidateInput = {
  schemaName: string;
  jobId: string;
  jobFingerprint: string;
  workerId: string;
  result: TrainingWorkerSuccess;
  storageRoot: string;
  promote?: PromoteCallback;
  onLinked?: (absolutePath: string) => void;
  successMessageTemplate?: string;
};

const RECHECK_CLAIMED_JOB_SQL =
  "SELECT fingerprint, claimed_by, status FROM training_jobs WHERE id = $1";

const LOCK_DATASET_DEFINITION_SQL = `
    SELECT dd.id
    FROM training_jobs tj
    JOIN dataset_snapshots ds ON ds.id = tj.dataset_snapshot_id
    JOIN dataset_definitions dd ON dd.id = ds.dataset_definition_id
    WHERE tj.id = $1
    FOR UPDATE OF dd
`;

const NEXT_MODEL_VERSION_SQL =
  "SELECT COALESCE(MAX(version_number), 0) + 1 AS version_number " +
  "FROM model_versions WHERE dataset_definition_id = $1";

const LOAD_DATASET_COLUMNS_SQL =
  "SELECT column_name, position, description, unit, is_nullable " +
  "FROM dataset_columns WHERE dataset_definition_id = $1";

const INSERT_MODEL_VERSION_SQL = `
    INSERT INTO model_versions (
      dataset_definition_id, training_job_id, version_number, status,
      metrics, baseline_metrics, parent_version_id
    )
    VALUES ($1, $2, $3, 'candidate', $4::jsonb, $5::jsonb, NULL)
    RETURNING id, version_number
`;

const INSERT_MODEL_ARTIFACT_SQL = `
    INSERT INTO model_artifacts (
      model_version_id, storage_uri, format, content_sha256, size_bytes,
      producer_worker_id, produced_at
    )
    VALUES ($1, $2, 'onnx', $3, $4, $5, now())
`;

const INSERT_MODEL_FEATURE_SQL = `
    INSERT INTO model_features (
      model_version_id, column_name, position, data_type, description,
      unit, is_required, valid_min, valid_max, allowed_values, missing_rate
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      $10::jsonb, $11
    )
`;

const COMPLETE_JOB_WITH_MODEL_SQL = `
    UPDATE training_jobs
    SET status = 'succeeded',
        progress_percent = 100,
        progress_message = $3,
        error_code = NULL,
        error_message = NULL,
        heartbeat_at = now(),
        finished_at = now(),
        updated_at = now()
    WHERE id = $1
      AND claimed_by = $2
      AND status = 'running'
`;

const LOOKUP_JOB_SQL =
  "SELECT claimed_by, status FROM training_jobs WHERE id = $1";

const MARK_JOB_FAILED_SQL = `
    UPDATE training_jobs
    SET status = 'failed',
        progress_percent = GREATEST(progress_percent, 0),
        progress_message = 'Training job failed',
        error_code = $3,
        error_message = $4,
        heartbeat_at = now(),
        finished_at = now(),
        updated_at = now()
    WHERE id = $1
      AND claimed_by = $2
      AND status = 'running'
`;

/**
 * Registers one candidate model inside an open tenant-scoped transaction
 * and moves its job to ``succeeded`` in the same transaction. The caller
 * owns opening and committing the transaction and deleting promoted files
 * when the transaction did not commit.
 *
 * Ordering mirrors the reviewed worker implementation: claim re-check,
 * dataset definition lock, server-side version allocation, promotion and
 * re-verification between lock and inserts, trusted-column feature join,
 * three inserts, ownership-guarded success update.
 */
export async function registerCandidateModel(
  client: PoolClient,
  input: RegisterCandidateInput,
): Promise<RegisteredCandidate> {
  await reassertClaimedJob(client, input.jobId, input.workerId, input.jobFingerprint);

  const datasetDefinitionId = await lockDatasetDefinition(client, input);

  const nextVersion = await client.query<{ version_number: number }>(
    NEXT_MODEL_VERSION_SQL,
    [datasetDefinitionId],
  );
  const versionNumber = nextVersion.rows[0]!.version_number;

  const basePromoter =
    input.promote ?? createDefaultPromoter(input, datasetDefinitionId);
  const promoted = await basePromoter(versionNumber);

  const joinedFeatures = await joinFeatureMetadata(
    client,
    datasetDefinitionId,
    input.result.features,
  );

  const insertedVersion = await client.query<{
    id: string;
    version_number: number;
  }>(INSERT_MODEL_VERSION_SQL, [
    datasetDefinitionId,
    input.jobId,
    versionNumber,
    JSON.stringify(input.result.metrics),
    JSON.stringify(input.result.baselineMetrics),
  ]);
  const modelVersionId = insertedVersion.rows[0]!.id;

  await client.query(INSERT_MODEL_ARTIFACT_SQL, [
    modelVersionId,
    promoted.storageUri,
    input.result.artifact.contentSha256,
    input.result.artifact.sizeBytes,
    input.workerId,
  ]);

  for (const feature of joinedFeatures) {
    await client.query(INSERT_MODEL_FEATURE_SQL, [
      modelVersionId,
      feature.columnName,
      feature.position,
      feature.dataType,
      feature.description,
      feature.unit,
      feature.isRequired,
      feature.validMin,
      feature.validMax,
      feature.allowedValues === null
        ? null
        : JSON.stringify(feature.allowedValues),
      feature.missingRate,
    ]);
  }

  const completionMessage = (
    input.successMessageTemplate ?? DEFAULT_SUCCESS_MESSAGE_TEMPLATE
  ).replaceAll("{version}", String(insertedVersion.rows[0]!.version_number));
  const completed = await client.query(COMPLETE_JOB_WITH_MODEL_SQL, [
    input.jobId,
    input.workerId,
    completionMessage,
  ]);

  if (completed.rowCount === 0) {
    await raiseJobGuardConflict(client, input.jobId);
  }

  return {
    modelVersionId,
    versionNumber: insertedVersion.rows[0]!.version_number,
    storageUri: promoted.storageUri,
  };
}

/**
 * Records a structured training failure for one claimed running job in an
 * open tenant-scoped transaction. The claim re-check mirrors the success
 * path so a stale or foreign worker result can never mutate the job.
 */
export async function markTrainingJobFailed(
  client: PoolClient,
  input: {
    jobId: string;
    jobFingerprint: string;
    workerId: string;
    errorCode: string;
    errorMessage: string;
  },
): Promise<void> {
  await reassertClaimedJob(
    client,
    input.jobId,
    input.workerId,
    input.jobFingerprint,
  );

  const updated = await client.query(MARK_JOB_FAILED_SQL, [
    input.jobId,
    input.workerId,
    input.errorCode.slice(0, 100),
    input.errorMessage.slice(0, 500),
  ]);

  if (updated.rowCount === 0) {
    await raiseJobGuardConflict(client, input.jobId);
  }
}

async function reassertClaimedJob(
  client: PoolClient,
  jobId: string,
  workerId: string,
  jobFingerprint: string,
): Promise<void> {
  const claimed = await client.query<{
    fingerprint: string;
    claimed_by: string | null;
    status: string;
  }>(RECHECK_CLAIMED_JOB_SQL, [jobId]);

  if (claimed.rowCount === 0) {
    throw new CandidateRegistrationError(
      "JOB_OWNERSHIP",
      `training job '${jobId}' was not found`,
    );
  }

  const row = claimed.rows[0]!;

  if (row.fingerprint !== jobFingerprint) {
    throw new CandidateRegistrationError(
      "JOB_OWNERSHIP",
      `training job '${jobId}' fingerprint does not match the submitted result`,
    );
  }

  if (row.claimed_by !== workerId) {
    throw new CandidateRegistrationError(
      "JOB_OWNERSHIP",
      `training job '${jobId}' is claimed by '${row.claimed_by}', not by this worker`,
    );
  }

  if (row.status !== "running") {
    throw new CandidateRegistrationError(
      "JOB_STATE_CONFLICT",
      `training job '${jobId}' is in status '${row.status}', expected 'running'`,
    );
  }
}

async function lockDatasetDefinition(
  client: PoolClient,
  input: RegisterCandidateInput,
): Promise<string> {
  const definition = await client.query<{ id: string }>(
    LOCK_DATASET_DEFINITION_SQL,
    [input.jobId],
  );

  if (definition.rowCount === 0) {
    throw new CandidateRegistrationError(
      "MODEL_FEATURE_METADATA_INVALID",
      "The dataset definition for the training job no longer exists",
    );
  }

  return definition.rows[0]!.id;
}

function defaultPromoter(
  input: RegisterCandidateInput,
  datasetDefinitionId: string,
): PromoteCallback {
  return async (versionNumber) => {
    const finalPath = buildModelArtifactPath(
      input.storageRoot,
      datasetDefinitionId,
      versionNumber,
      input.jobId,
    );
    const storageUri = `models/${datasetDefinitionId}/v${versionNumber}/${input.jobId}.onnx`;

    const tempResolution = resolveTempArtifactPath(
      input.storageRoot,
      input.result.artifact.storageUri,
    );

    if (!tempResolution.ok) {
      throw new CandidateRegistrationError(
        "MODEL_ARTIFACT_PROMOTION_FAILED",
        tempResolution.message,
      );
    }

    const promotion = await promoteArtifact(tempResolution.absolutePath, finalPath);

    if (!promotion.ok) {
      throw new CandidateRegistrationError(
        "MODEL_ARTIFACT_PROMOTION_FAILED",
        promotion.message,
      );
    }

    // Report the linked path before re-verification so the caller can
    // clean up an orphan even when the payload does not describe the
    // bytes that were promoted.
    input.onLinked?.(finalPath);

    const verification = await verifyPromotedArtifact(
      finalPath,
      input.result.artifact.contentSha256,
      input.result.artifact.sizeBytes,
    );

    if (!verification.ok) {
      throw new CandidateRegistrationError(
        verification.reason === "ARTIFACT_NOT_FOUND"
          ? "MODEL_ARTIFACT_PROMOTION_FAILED"
          : "MODEL_ARTIFACT_CHECKSUM_MISMATCH",
        verification.message,
      );
    }

    return { storageUri, absolutePath: finalPath };
  };
}

export function createDefaultPromoter(
  input: RegisterCandidateInput,
  datasetDefinitionId: string,
): PromoteCallback {
  return defaultPromoter(input, datasetDefinitionId);
}

type JoinedModelFeature = {
  columnName: string;
  position: number;
  dataType: TrainingWorkerModelFeature["dataType"];
  description: string;
  unit: string | null;
  isRequired: boolean;
  validMin: number | null;
  validMax: number | null;
  allowedValues: (string | number)[] | null;
  missingRate: number;
};

async function joinFeatureMetadata(
  client: PoolClient,
  datasetDefinitionId: string,
  features: TrainingWorkerModelFeature[],
): Promise<JoinedModelFeature[]> {
  if (features.length === 0) {
    throw new CandidateRegistrationError(
      "MODEL_FEATURE_METADATA_INVALID",
      "The validated result payload carries no model features",
    );
  }

  const columns = await client.query<{
    column_name: string;
    position: number;
    description: string;
    unit: string | null;
    is_nullable: boolean;
  }>(LOAD_DATASET_COLUMNS_SQL, [datasetDefinitionId]);

  const metadata = new Map(
    columns.rows.map((column) => [
      `${column.column_name}:${column.position}`,
      column,
    ]),
  );

  return features.map((feature) => {
    const column = metadata.get(`${feature.name}:${feature.position}`);

    if (!column) {
      throw new CandidateRegistrationError(
        "MODEL_FEATURE_METADATA_INVALID",
        `Feature '${feature.name}' at position ${feature.position} does not match the dataset columns`,
      );
    }

    return {
      columnName: feature.name,
      position: feature.position,
      dataType: feature.dataType,
      description: column.description,
      unit: column.unit,
      isRequired: !column.is_nullable,
      validMin: feature.validMin,
      validMax: feature.validMax,
      allowedValues: feature.allowedValues,
      missingRate: feature.missingRate,
    };
  });
}

export function mapUniqueViolation(error: unknown): CandidateRegistrationError | null {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { code?: unknown }).code !== "23505"
  ) {
    return null;
  }

  const constraint =
    ((error as { constraint?: unknown }).constraint as string | undefined) ??
    ((error as { detail?: unknown }).detail as string | undefined) ??
    "";

  if (constraint.includes("dataset_version") || constraint.includes("training_job_id")) {
    return new CandidateRegistrationError(
      "MODEL_VERSION_CONFLICT",
      "The candidate model version conflicts with an existing registration",
    );
  }

  if (constraint.includes("content_sha256")) {
    return new CandidateRegistrationError(
      "MODEL_ARTIFACT_CONTENT_CONFLICT",
      "A model artifact with the same content digest is already registered",
    );
  }

  return null;
}

async function raiseJobGuardConflict(client: PoolClient, jobId: string): Promise<never> {
  const current = await client.query<{
    claimed_by: string | null;
    status: string;
  }>(LOOKUP_JOB_SQL, [jobId]);

  if (current.rowCount === 0) {
    throw new CandidateRegistrationError(
      "JOB_OWNERSHIP",
      `training job '${jobId}' was not found`,
    );
  }

  const row = current.rows[0]!;

  if (row.status !== "running") {
    throw new CandidateRegistrationError(
      "JOB_STATE_CONFLICT",
      `training job '${jobId}' is in status '${row.status}', expected 'running'`,
    );
  }

  throw new CandidateRegistrationError(
    "JOB_OWNERSHIP",
    `training job '${jobId}' is claimed by '${row.claimed_by}', not by this worker`,
  );
}

const RECONCILE_REGISTRATION_SQL =
  "SELECT mv.id AS model_version_id, mv.version_number, ma.storage_uri " +
  "FROM model_versions mv JOIN model_artifacts ma ON ma.model_version_id = mv.id " +
  "WHERE mv.training_job_id = $1";

/**
 * Reconciles an ambiguous commit on a fresh connection. Returns the
 * registered candidate when the commit landed and ``null`` only when the
 * job definitively has no registered candidate. Transient reconciliation
 * failures throw so the caller never mistakes an unknown outcome for a
 * confirmed rollback and deletes promoted artifacts.
 */
export async function reconcileRegistration(
  pool: Pool,
  schemaName: string,
  jobId: string,
): Promise<RegisteredCandidate | null> {
  assertTenantSchemaName(schemaName);

  let client: PoolClient | undefined;

  try {
    client = await pool.connect();
    client.on("error", () => {});

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schemaName}"`);
      const existing = await client.query<{
        model_version_id: string;
        version_number: number;
        storage_uri: string;
      }>(RECONCILE_REGISTRATION_SQL, [jobId]);

      await client.query("COMMIT");

      const row = existing.rows[0];

      if (!row) {
        return null;
      }

      return {
        modelVersionId: row.model_version_id,
        versionNumber: row.version_number,
        storageUri: row.storage_uri,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } catch (error) {
    console.error(
      "Ambiguous-commit reconciliation could not read the registration",
      error,
    );
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    client?.release();
  }
}

export type ResultSubmissionOutcome =
  | { kind: "registered"; candidate: RegisteredCandidate }
  | { kind: "failure-recorded" }
  | {
      kind: "rejected";
      httpStatus: 409 | 422;
      code: CandidateRegistrationErrorCode;
      message: string;
    }
  | { kind: "unavailable"; message: string };

export type SubmissionDependencies = {
  runTransaction: <Result>(
    schemaName: string,
    operation: (client: PoolClient) => Promise<Result>,
  ) => Promise<Result>;
  /**
   * Resolves one ambiguous commit on a fresh connection. Returns the
   * committed candidate, or null only when the job definitively has no
   * candidate. Implementations must throw on transient failures so the
   * caller can keep promoted artifacts instead of deleting an unknown
   * outcome.
   */
  reconcile: (
    pool: Pool,
    schemaName: string,
    jobId: string,
  ) => Promise<RegisteredCandidate | null>;
};

export const defaultSubmissionDependencies: SubmissionDependencies = {
  runTransaction: withTenantTransaction,
  reconcile: reconcileRegistration,
};

function rejection(
  error: CandidateRegistrationError,
): ResultSubmissionOutcome {
  return {
    kind: "rejected",
    httpStatus:
      error.code === "JOB_OWNERSHIP" ||
      error.code === "JOB_STATE_CONFLICT" ||
      error.code === "MODEL_VERSION_CONFLICT" ||
      error.code === "MODEL_ARTIFACT_CONTENT_CONFLICT"
        ? 409
        : 422,
    code: error.code,
    message: error.message,
  };
}

async function deletePromotedArtifacts(paths: string[]): Promise<void> {
  for (const path of paths) {
    await deleteArtifact(path).catch(() => {});
  }
}

/**
 * Handles one success-result submission end to end: runs the registration
 * transaction, enforces the cleanup contract, and reconciles an ambiguous
 * commit on a fresh connection. When the reconciliation finds the commit
 * landed, the registered candidate is returned as an idempotent success so
 * a worker retry observes the same response as the original attempt.
 */
export async function submitSuccessResult(
  pool: Pool,
  input: RegisterCandidateInput,
  dependencies: SubmissionDependencies = defaultSubmissionDependencies,
): Promise<ResultSubmissionOutcome> {
  const promotedPaths: string[] = [];

  try {
    const candidate = await dependencies.runTransaction(
      input.schemaName,
      (client) =>
        registerCandidateModel(client, {
          ...input,
          onLinked: (absolutePath) => {
            promotedPaths.push(absolutePath);
          },
        }),
    );
    return { kind: "registered", candidate };
  } catch (error) {
    const violation = mapUniqueViolation(error);

    if (violation !== null || error instanceof CandidateRegistrationError) {
      await deletePromotedArtifacts(promotedPaths);
      return rejection(violation ?? (error as CandidateRegistrationError));
    }

    console.error(
      "Training result submission failed inside the registration transaction",
      error,
    );

    let reconciled: RegisteredCandidate | null;
    try {
      reconciled = await dependencies.reconcile(
        pool,
        input.schemaName,
        input.jobId,
      );
    } catch (reconcileError) {
      console.error(
        "Ambiguous-commit reconciliation failed; promoted artifacts are kept for inspection",
        reconcileError,
      );
      return {
        kind: "unavailable",
        message: "The registration outcome could not be confirmed",
      };
    }

    if (reconciled) {
      return { kind: "registered", candidate: reconciled };
    }

    await deletePromotedArtifacts(promotedPaths);
    return {
      kind: "unavailable",
      message: "The registration outcome could not be confirmed",
    };
  }
}

export type FailureSubmissionInput = {
  schemaName: string;
  jobId: string;
  jobFingerprint: string;
  workerId: string;
  errorCode: string;
  errorMessage: string;
};

/**
 * Handles one failure-result submission: records the structured training
 * failure with the payload's bounded code and message. Registration errors
 * surface as rejections; anything unexpected is reported as unavailable so
 * the worker can retry.
 */
export async function submitFailureResult(
  input: FailureSubmissionInput,
  dependencies: SubmissionDependencies = defaultSubmissionDependencies,
): Promise<ResultSubmissionOutcome> {
  try {
    await dependencies.runTransaction(input.schemaName, (client) =>
      markTrainingJobFailed(client, input),
    );
    return { kind: "failure-recorded" };
  } catch (error) {
    if (error instanceof CandidateRegistrationError) {
      return rejection(error);
    }
    return {
      kind: "unavailable",
      message: "The failure could not be recorded",
    };
  }
}
