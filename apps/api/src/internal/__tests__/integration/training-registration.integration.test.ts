import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import pg from "pg";

process.env.DATABASE_URL ||= "postgresql://ampersand:ampersand@localhost:5432/ampersand";

const { defaultSubmissionDependencies, submitSuccessResult } = await import(
  "../../training-registration"
);
const fsModule = await import("../../fs");

const { Pool } = pg;
const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

function resolveDatabaseUrl(): string | undefined {
  const direct = process.env.DATABASE_URL;

  if (direct && !direct.includes("unused")) {
    return direct;
  }

  const envFile = join(
    import.meta.dir,
    "../../../../../../.env",
  );

  try {
    const contents = require("node:fs").readFileSync(envFile, "utf8") as string;

    for (const line of contents.split("\n")) {
      if (line.startsWith("DATABASE_URL=")) {
        return line.slice("DATABASE_URL=".length).trim();
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

const adminPool = new Pool({ connectionString: databaseUrl });
const registrationPool = new Pool({ connectionString: databaseUrl });
registrationPool.on("error", () => {});
adminPool.on("error", () => {});

function runRegistrationTransaction<T>(
  schemaName: string,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withClientTransaction(registrationPool, schemaName, operation);
}

async function withClientTransaction<T>(
  pool: pg.Pool,
  schemaName: string,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  client.on("error", () => {});

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schemaName}"`);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const submissionDependencies = {
  ...defaultSubmissionDependencies,
  runTransaction: runRegistrationTransaction,
};

afterAll(async () => {
  await adminPool.end();
  await registrationPool.end();
});

const TRAINING_JOBS_DDL = `
CREATE TABLE training_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint char(64) NOT NULL,
    dataset_snapshot_id uuid,
    training_config jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL,
    progress_percent integer NOT NULL DEFAULT 0,
    progress_message text,
    claimed_by varchar(255),
    queued_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    heartbeat_at timestamptz,
    finished_at timestamptz,
    error_code varchar(100),
    error_message text,
    max_runtime_seconds integer NOT NULL DEFAULT 600,
    is_active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);`;

const REGISTRATION_DDL = `
CREATE TABLE dataset_definitions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(200) NOT NULL,
    source_schema varchar(63) NOT NULL,
    source_table varchar(63) NOT NULL,
    target_column varchar(63) NOT NULL,
    time_column varchar(63),
    is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE dataset_columns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_definition_id uuid NOT NULL REFERENCES dataset_definitions(id)
        ON DELETE CASCADE,
    column_name varchar(255) NOT NULL,
    role varchar(16) NOT NULL CHECK (role IN ('feature', 'target', 'time', 'ignored')),
    data_type varchar(16) NOT NULL CHECK (data_type IN ('number', 'integer', 'boolean', 'category', 'text', 'datetime')),
    description text NOT NULL,
    unit varchar(100),
    is_nullable boolean NOT NULL,
    position integer NOT NULL CHECK (position >= 0),
    CONSTRAINT uq_dataset_columns_definition_name UNIQUE (dataset_definition_id, column_name)
);

CREATE TABLE dataset_snapshots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_definition_id uuid NOT NULL REFERENCES dataset_definitions(id)
        ON DELETE CASCADE,
    storage_uri text NOT NULL,
    storage_format varchar(16) NOT NULL CHECK (storage_format IN ('parquet')),
    content_sha256 char(64) NOT NULL UNIQUE,
    row_count bigint NOT NULL CHECK (row_count > 0),
    schema_summary jsonb NOT NULL,
    frozen_at timestamptz NOT NULL
);

CREATE TABLE model_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_definition_id uuid NOT NULL REFERENCES dataset_definitions(id)
        ON DELETE RESTRICT,
    training_job_id uuid NOT NULL REFERENCES training_jobs(id)
        ON DELETE RESTRICT,
    version_number integer NOT NULL CHECK (version_number > 0),
    status varchar(16) NOT NULL CHECK (status IN ('candidate', 'published', 'retired')),
    parent_version_id uuid,
    metrics jsonb NOT NULL,
    baseline_metrics jsonb NOT NULL,
    published_at timestamptz,
    published_by uuid,
    retired_at timestamptz,
    retired_by uuid,
    is_active boolean NOT NULL DEFAULT true,
    CONSTRAINT uq_model_versions_dataset_version
        UNIQUE (dataset_definition_id, version_number),
    CONSTRAINT uq_model_versions_training_job_id UNIQUE (training_job_id)
);

CREATE TABLE model_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_version_id uuid NOT NULL REFERENCES model_versions(id)
        ON DELETE RESTRICT,
    storage_uri text NOT NULL,
    format varchar(16) NOT NULL CHECK (format IN ('onnx')),
    content_sha256 char(64) NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes > 0),
    producer_worker_id varchar(255) NOT NULL,
    produced_at timestamptz NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    CONSTRAINT uq_model_artifacts_model_version_id UNIQUE (model_version_id),
    CONSTRAINT model_artifacts_content_sha256_unique UNIQUE (content_sha256)
);

CREATE TABLE model_features (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_version_id uuid NOT NULL REFERENCES model_versions(id)
        ON DELETE CASCADE,
    column_name varchar(255) NOT NULL,
    position integer NOT NULL CHECK (position >= 0),
    data_type varchar(16) NOT NULL CHECK (data_type IN ('number', 'integer', 'boolean', 'category')),
    description text NOT NULL,
    unit varchar(100),
    is_required boolean NOT NULL,
    valid_min numeric,
    valid_max numeric,
    allowed_values jsonb,
    missing_rate numeric NOT NULL CHECK (missing_rate BETWEEN 0 AND 1),
    is_active boolean NOT NULL DEFAULT true,
    CONSTRAINT uq_model_features_version_column
        UNIQUE (model_version_id, column_name),
    CONSTRAINT uq_model_features_version_position
        UNIQUE (model_version_id, position)
);`;

const DEFINITION_ID = "33333333-4333-4333-8333-333333333333";

type Fixture = {
  schemaName: string;
  storageRoot: string;
};

async function dropSchema(schemaName: string) {
  await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
}

async function makeFixture(): Promise<Fixture> {
  const schemaName = `tmp_api_reg_${Math.random().toString(16).slice(2, 10)}`;
  const client = await adminPool.connect();

  try {
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);
    await client.query(TRAINING_JOBS_DDL);
    await client.query(REGISTRATION_DDL);
  } finally {
    await client.query("RESET search_path").catch(() => {});
    client.release();
  }

  const storageRoot = await mkdtemp(join(tmpdir(), "ampersand-reg-int-"));

  return { schemaName, storageRoot };
}

async function seedDataset(admin: pg.PoolClient | pg.Pool, schemaName: string) {
  await admin.query(`SET search_path TO "${schemaName}"`);
  await admin.query(
    `INSERT INTO dataset_definitions
      (id, name, source_schema, source_table, target_column)
     VALUES ($1, 'Energy readings', 'public', 'energy_readings', 'energy_usage')`,
    [DEFINITION_ID],
  );
  await admin.query(
    `INSERT INTO dataset_columns
      (dataset_definition_id, column_name, role, data_type, description, unit, is_nullable, position)
     VALUES
      ($1, 'temperature', 'feature', 'number', 'Air temperature in celsius', 'C', false, 0),
      ($1, 'occupancy', 'feature', 'integer', 'People count', NULL, true, 1)`,
    [DEFINITION_ID],
  );
}

type ClaimedJobFixture = {
  jobId: string;
  fingerprint: string;
  payloadBytes: Buffer;
  workerId: string;
};

async function seedClaimedJob(
  admin: pg.PoolClient | pg.Pool,
  schemaName: string,
  workerId = "worker-a",
  payloadSeed = "integration verified onnx payload",
): Promise<ClaimedJobFixture> {
  await admin.query(`SET search_path TO "${schemaName}"`);
  const snapshotSalt = `${schemaName}:${workerId}:${payloadSeed}`;
  const snapshot = await admin.query<{ id: string }>(
    `INSERT INTO dataset_snapshots
      (dataset_definition_id, storage_uri, storage_format, content_sha256, row_count, schema_summary, frozen_at)
     VALUES ($1, $2, 'parquet', $3, 5, '{}', now()) RETURNING id`,
    [
      DEFINITION_ID,
      `snapshots/${schemaName}.parquet`,
      createHash("sha256").update(snapshotSalt).digest("hex"),
    ],
  );
  const fingerprint = createHash("sha256")
    .update(`${schemaName}:${payloadSeed}`)
    .digest("hex");
  const job = await admin.query<{ id: string }>(
    `INSERT INTO training_jobs
      (dataset_snapshot_id, fingerprint, status, progress_percent, progress_message)
     VALUES ($1, $2, 'queued', 0, 'Waiting for a worker') RETURNING id`,
    [snapshot.rows[0]!.id, fingerprint],
  );
  const jobId = job.rows[0]!.id;

  await admin.query(
    `UPDATE training_jobs
     SET status = 'running', claimed_by = $2, started_at = now(), heartbeat_at = now()
     WHERE id = $1`,
    [jobId, workerId],
  );

  return {
    jobId,
    fingerprint,
    payloadBytes: Buffer.from(payloadSeed),
    workerId,
  };
}

function successPayload(job: ClaimedJobFixture) {
  return {
    status: "succeeded" as const,
    metrics: { mae: 1.5, rmse: 2, r2: 0.85 },
    baselineMetrics: { mae: 6, rmse: 6.5, r2: 0 },
    artifact: {
      storageUri: `${job.jobId}.temp.onnx.tmp`,
      format: "onnx" as const,
      contentSha256: createHash("sha256").update(job.payloadBytes).digest("hex"),
      sizeBytes: job.payloadBytes.byteLength,
    },
    features: [
      {
        name: "temperature",
        position: 0,
        dataType: "number" as const,
        validMin: -20,
        validMax: 50,
        allowedValues: null,
        missingRate: 0.1,
      },
      {
        name: "occupancy",
        position: 1,
        dataType: "integer" as const,
        validMin: null,
        validMax: null,
        allowedValues: [0, 1, 2],
        missingRate: 0,
      },
    ],
    splitMetadata: {
      strategy: "chronological" as const,
      timeColumn: "recorded_at",
      trainRowCount: 80,
      testRowCount: 20,
      testFraction: 0.2,
      roundingRule: "round(rowCount * testFraction)",
      trainingBoundary: null,
      testStart: null,
      randomSeed: 42,
      featureOrder: ["temperature", "occupancy"],
      trainerVersion: "1.0.0",
      dependencyVersions: { python: "3.11" },
    },
  };
}

async function writeTempPayload(fixture: Fixture, job: ClaimedJobFixture) {
  const { writeFile } = await import("node:fs/promises");
  const tempPath = join(fixture.storageRoot, `${job.jobId}.temp.onnx.tmp`);
  await writeFile(tempPath, job.payloadBytes);
  return tempPath;
}

async function submitSuccess(
  fixture: Fixture,
  job: ClaimedJobFixture,
  pool: pg.Pool = registrationPool,
) {
  await writeTempPayload(fixture, job);

  return submitSuccessResult(pool, {
    schemaName: fixture.schemaName,
    jobId: job.jobId,
    jobFingerprint: job.fingerprint,
    workerId: job.workerId,
    result: successPayload(job),
    storageRoot: fixture.storageRoot,
  }, submissionDependencies);
}

async function installTrigger(
  schemaName: string,
  createFunctionSql: string,
  createTriggerSql: string,
) {
  const client = await adminPool.connect();
  try {
    await client.query(`SET search_path TO "${schemaName}"`);
    const fullFunctionSql = createFunctionSql.startsWith("CREATE OR REPLACE FUNCTION")
      ? createFunctionSql
      : `CREATE OR REPLACE FUNCTION ${createFunctionSql}`;
    await client.query(fullFunctionSql);
    await client.query(createTriggerSql);
  } finally {
    client.release();
  }
}

describe("internal training registration database integration", () => {
  test("persists candidate metadata, artifact, features, and succeeds the job", async () => {
    const fixture = await makeFixture();

    try {
      const admin = await adminPool.connect();
      let job: ClaimedJobFixture;

      try {
        await seedDataset(admin, fixture.schemaName);
        job = await seedClaimedJob(admin, fixture.schemaName);
      } finally {
        admin.release();
      }

      const outcome = await submitSuccess(fixture, job);

      expect(outcome.kind).toBe("registered");
      if (outcome.kind !== "registered") return;

      const expectedUri = `models/${DEFINITION_ID}/v1/${job.jobId}.onnx`;
      expect(outcome.candidate.storageUri).toBe(expectedUri);
      expect(outcome.candidate.versionNumber).toBe(1);

      const finalPath = join(fixture.storageRoot, expectedUri);
      expect(await Bun.file(finalPath).exists()).toBe(true);

      const client = await adminPool.connect();
      try {
        await client.query(`SET search_path TO "${fixture.schemaName}"`);
        const version = await client.query<{
          status: string;
          metrics: unknown;
          parent_version_id: string | null;
        }>("SELECT status, metrics, parent_version_id FROM model_versions");
        const artifact = await client.query<{
          producer_worker_id: string;
          content_sha256: string;
          size_bytes: string;
          storage_uri: string;
        }>(
          "SELECT producer_worker_id, content_sha256, size_bytes, storage_uri FROM model_artifacts",
        );
        const features = await client.query<{
          column_name: string;
          description: string;
          unit: string | null;
          is_required: boolean;
          position: number;
        }>(
          "SELECT column_name, description, unit, is_required, position FROM model_features ORDER BY position",
        );
        const jobRow = await client.query<{
          status: string;
          progress_percent: number;
          finished_at: Date | null;
        }>(
          "SELECT status, progress_percent, finished_at FROM training_jobs WHERE id = $1",
          [job.jobId],
        );

        expect(version.rows[0]?.status).toBe("candidate");
        expect(version.rows[0]?.parent_version_id).toBeNull();

        expect(artifact.rows[0]?.producer_worker_id).toBe("worker-a");
        expect(artifact.rows[0]?.storage_uri).toBe(expectedUri);
        expect(artifact.rows[0]?.content_sha256).toBe(
          createHash("sha256").update(job.payloadBytes).digest("hex"),
        );
        expect(Number(artifact.rows[0]?.size_bytes)).toBe(
          job.payloadBytes.byteLength,
        );

        expect(features.rows.map((row) => row.column_name)).toEqual([
          "temperature",
          "occupancy",
        ]);
        expect(features.rows[0]?.description).toBe("Air temperature in celsius");
        expect(features.rows[0]?.unit).toBe("C");
        expect(features.rows[0]?.is_required).toBe(true);
        expect(features.rows[1]?.is_required).toBe(false);

        expect(jobRow.rows[0]?.status).toBe("succeeded");
        expect(jobRow.rows[0]?.progress_percent).toBe(100);
        expect(jobRow.rows[0]?.finished_at).not.toBeNull();
      } finally {
        client.release();
      }
    } finally {
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
    }
  });

  test("rejects a foreign claimed_by before promotion", async () => {
    const fixture = await makeFixture();

    try {
      const admin = await adminPool.connect();
      let job: ClaimedJobFixture;

      try {
        await seedDataset(admin, fixture.schemaName);
        job = await seedClaimedJob(admin, fixture.schemaName);
      } finally {
        admin.release();
      }

      await writeTempPayload(fixture, job);

      const outcome = await submitSuccessResult(registrationPool, {
        schemaName: fixture.schemaName,
        jobId: job.jobId,
        jobFingerprint: job.fingerprint,
        workerId: "worker-b",
        result: successPayload(job),
        storageRoot: fixture.storageRoot,
      }, submissionDependencies);

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.code).toBe("JOB_OWNERSHIP");
      }

      const modelsDir = join(fixture.storageRoot, "models");
      expect(await Bun.file(modelsDir).exists()).toBe(false);

      const rows = await adminPool.query(
        `SELECT COUNT(*)::int AS count FROM "${fixture.schemaName}".model_versions`,
        [],
      );
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
    }
  });

  test("rejects a fingerprint mismatch before promotion", async () => {
    const fixture = await makeFixture();

    try {
      const admin = await adminPool.connect();
      let job: ClaimedJobFixture;

      try {
        await seedDataset(admin, fixture.schemaName);
        job = await seedClaimedJob(admin, fixture.schemaName);
      } finally {
        admin.release();
      }

      await writeTempPayload(fixture, job);

      const outcome = await submitSuccessResult(registrationPool, {
        schemaName: fixture.schemaName,
        jobId: job.jobId,
        jobFingerprint: "c".repeat(64),
        workerId: "worker-a",
        result: successPayload(job),
        storageRoot: fixture.storageRoot,
      }, submissionDependencies);

      expect(outcome.kind).toBe("rejected");

      const rows = await adminPool.query(
        `SELECT COUNT(*)::int AS count FROM "${fixture.schemaName}".model_versions`,
        [],
      );
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
    }
  });

  test("rejects a hand-built fake payload whose checksum does not match the bytes", async () => {
    const fixture = await makeFixture();

    try {
      const admin = await adminPool.connect();
      let job: ClaimedJobFixture;

      try {
        await seedDataset(admin, fixture.schemaName);
        job = await seedClaimedJob(admin, fixture.schemaName);
      } finally {
        admin.release();
      }

      await writeTempPayload(fixture, job);

      const payload = successPayload(job);
      payload.artifact.contentSha256 = "d".repeat(64);

      const outcome = await submitSuccessResult(registrationPool, {
        schemaName: fixture.schemaName,
        jobId: job.jobId,
        jobFingerprint: job.fingerprint,
        workerId: "worker-a",
        result: payload,
        storageRoot: fixture.storageRoot,
      }, submissionDependencies);

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.code).toBe("MODEL_ARTIFACT_CHECKSUM_MISMATCH");
      }

      const counts = await adminPool.query(
        `SELECT
           (SELECT COUNT(*) FROM "${fixture.schemaName}".model_versions)::int AS versions,
           (SELECT COUNT(*) FROM "${fixture.schemaName}".model_artifacts)::int AS artifacts`,
        [],
      );
      expect(counts.rows[0]?.versions).toBe(0);
      expect(counts.rows[0]?.artifacts).toBe(0);

      expect(await directoryEmptyOfOnnx(fixture.storageRoot)).toBe(true);
    } finally {
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
    }
  });

  test("rolls back and cleans when a legacy writer injects a competing version", async () => {
    const fixture = await makeFixture();

    try {
      const admin = await adminPool.connect();
      let job: ClaimedJobFixture;
      let competing: ClaimedJobFixture;

      try {
        await seedDataset(admin, fixture.schemaName);
        job = await seedClaimedJob(admin, fixture.schemaName);
        competing = await seedClaimedJob(
          admin,
          fixture.schemaName,
          "worker-a",
          "competing payload",
        );
        await admin.query("SET search_path TO public");
        await installTrigger(
          fixture.schemaName,
          "inject_competing_version() RETURNS trigger AS $fn$ "
            + "BEGIN IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF; "
            + `INSERT INTO model_versions (dataset_definition_id, training_job_id, `
            + `version_number, status, metrics, baseline_metrics) `
            + `VALUES (NEW.dataset_definition_id, '${competing.jobId}', `
            + `NEW.version_number, 'candidate', '{}', '{}'); `
            + `RETURN NEW; END $fn$ LANGUAGE plpgsql`,
          `CREATE TRIGGER inject_version_before_candidate BEFORE INSERT ON `
            + `model_versions FOR EACH ROW EXECUTE FUNCTION inject_competing_version()`,
        );
      } finally {
        admin.release();
      }

      const outcome = await submitSuccess(fixture, job);

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.code).toBe("MODEL_VERSION_CONFLICT");
      }

      expect(await directoryEmptyOfOnnx(fixture.storageRoot)).toBe(true);

      const counts = await adminPool.query(
        `SELECT COUNT(*)::int AS count FROM "${fixture.schemaName}".model_versions`,
        [],
      );
      expect(counts.rows[0]?.count).toBe(0);
    } finally {
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
    }
  });

  test("the guarded success update rolls everything back when the job changes midflight", async () => {
    const fixture = await makeFixture();

    try {
      const admin = await adminPool.connect();
      let job: ClaimedJobFixture;

      try {
        await seedDataset(admin, fixture.schemaName);
        job = await seedClaimedJob(admin, fixture.schemaName);
        await admin.query("SET search_path TO public");
        await installTrigger(
          fixture.schemaName,
          "cancel_job_after_features() RETURNS trigger AS $fn$ "
            + "BEGIN UPDATE training_jobs SET status = 'cancelled', finished_at = now() "
            + "WHERE id = (SELECT training_job_id FROM model_versions WHERE id = NEW.model_version_id); "
            + "RETURN NULL; END $fn$ LANGUAGE plpgsql",
          `CREATE TRIGGER cancel_after_features AFTER INSERT ON model_features `
            + `FOR EACH ROW EXECUTE FUNCTION cancel_job_after_features()`,
        );
      } finally {
        admin.release();
      }

      const outcome = await submitSuccess(fixture, job);

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.code).toBe("JOB_STATE_CONFLICT");
      }

      expect(await directoryEmptyOfOnnx(fixture.storageRoot)).toBe(true);

      const counts = await adminPool.query(
        `SELECT COUNT(*)::int AS count FROM "${fixture.schemaName}".model_versions`,
        [],
      );
      expect(counts.rows[0]?.count).toBe(0);

      const jobRow = await adminPool.query<{ status: string }>(
        `SELECT status FROM "${fixture.schemaName}".training_jobs WHERE id = $1`,
        [job.jobId],
      );
      expect(jobRow.rows[0]?.status).toBe("running");
    } finally {
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
    }
  });

  test("responds idempotently when an ambiguous commit actually landed", async () => {
    const fixture = await makeFixture();

    try {
      const admin = await adminPool.connect();
      let job: ClaimedJobFixture;
      let firstOutcome: Awaited<ReturnType<typeof submitSuccess>>;

      try {
        await seedDataset(admin, fixture.schemaName);
        job = await seedClaimedJob(admin, fixture.schemaName);
      } finally {
        admin.release();
      }

      firstOutcome = await submitSuccess(fixture, job);
      expect(firstOutcome.kind).toBe("registered");

      await adminPool.query(
        `UPDATE "${fixture.schemaName}".training_jobs SET status = 'running', finished_at = NULL WHERE id = $1`,
        [job.jobId],
      );

      const retryOutcome = await submitSuccessResult(
        registrationPool,
        {
          schemaName: fixture.schemaName,
          jobId: job.jobId,
          jobFingerprint: job.fingerprint,
          workerId: "worker-a",
          result: successPayload(job),
          storageRoot: fixture.storageRoot,
        },
        {
          ...submissionDependencies,
          runTransaction: async () => {
            throw new Error("connection terminated during commit");
          },
        },
      );

      expect(retryOutcome.kind).toBe("registered");
      if (retryOutcome.kind === "registered" && firstOutcome.kind === "registered") {
        expect(retryOutcome.candidate.modelVersionId).toBe(
          firstOutcome.candidate.modelVersionId,
        );
        expect(retryOutcome.candidate.versionNumber).toBe(
          firstOutcome.candidate.versionNumber,
        );
      }
    } finally {
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
    }
  });

  test("concurrent registrations serialize to distinct sequential versions", async () => {
    const fixture = await makeFixture();

    try {
      const admin = await adminPool.connect();
      let first: ClaimedJobFixture;
      let second: ClaimedJobFixture;

      try {
        await seedDataset(admin, fixture.schemaName);
        first = await seedClaimedJob(
          admin,
          fixture.schemaName,
          "worker-a",
          "first concurrent payload",
        );
        second = await seedClaimedJob(
          admin,
          fixture.schemaName,
          "worker-b",
          "second concurrent payload",
        );
      } finally {
        admin.release();
      }

      const [one, two] = await Promise.all([
        submitSuccess(fixture, first),
        submitSuccess(fixture, second),
      ]);

      expect(one.kind).toBe("registered");
      expect(two.kind).toBe("registered");

      if (one.kind === "registered" && two.kind === "registered") {
        const versions = [one.candidate.versionNumber, two.candidate.versionNumber].sort();
        expect(versions).toEqual([1, 2]);
      }
    } finally {
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
    }
  });

  test("a killed backend before commit leaves no rows and no files", async () => {
    const fixture = await makeFixture();

    // A dedicated pool: the terminated backend would leave a dead client
    // inside the shared registration pool and flake later checkouts.
    const killPool = new Pool({ connectionString: databaseUrl });
    killPool.on("error", () => {});

    try {
      const admin = await adminPool.connect();
      let job: ClaimedJobFixture;

      try {
        await seedDataset(admin, fixture.schemaName);
        job = await seedClaimedJob(admin, fixture.schemaName);
        await admin.query("SET search_path TO public");
        await installTrigger(
          fixture.schemaName,
          "kill_current_backend() RETURNS trigger AS $fn$ "
            + "BEGIN PERFORM pg_terminate_backend(pg_backend_pid()); "
            + "RETURN NULL; END $fn$ LANGUAGE plpgsql",
          `CREATE TRIGGER kill_after_features AFTER INSERT ON model_features `
            + `FOR EACH STATEMENT EXECUTE FUNCTION kill_current_backend()`,
        );
      } finally {
        admin.release();
      }

      const outcome = await submitSuccess(fixture, job, killPool);

      expect(outcome.kind).toBe("unavailable");
      expect(await directoryEmptyOfOnnx(fixture.storageRoot)).toBe(true);

      const counts = await adminPool.query(
        `SELECT COUNT(*)::int AS count FROM "${fixture.schemaName}".model_versions`,
        [],
      );
      expect(counts.rows[0]?.count).toBe(0);

      const jobRow = await adminPool.query<{ status: string }>(
        `SELECT status FROM "${fixture.schemaName}".training_jobs WHERE id = $1`,
        [job.jobId],
      );
      expect(jobRow.rows[0]?.status).toBe("running");
    } finally {
      await killPool.end();
      await rm(fixture.storageRoot, { recursive: true, force: true });
      await dropSchema(fixture.schemaName);
      await adminPool
        .query("DROP FUNCTION IF EXISTS public.kill_current_backend() CASCADE")
        .catch(() => {});
    }
  });
});

async function directoryEmptyOfOnnx(storageRoot: string): Promise<boolean> {
  const { readdir } = await import("node:fs/promises");
  const modelsDir = join(storageRoot, "models");

  try {
    const entries = await readdir(modelsDir, { recursive: true });
    return !entries.some((entry) => entry.endsWith(".onnx"));
  } catch {
    return true;
  }
}
