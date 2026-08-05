import pg from "pg";

import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CreateDatasetDefinitionDto,
  CreateTrainingJobDto,
  DatasetDefinitionResponseDto,
  TrainingJobResponseDto,
  TrainingWorkerInputDto,
  TrainingWorkerResultDto,
} from "@ampersand/contracts";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const subdomain = process.env.DEV_TENANT_SUBDOMAIN ?? "ampersand-dev";
const workerId = "mock-worker";
const mockOutcome = process.env.MOCK_TRAINING_OUTCOME ?? "succeeded";
if (mockOutcome !== "succeeded" && mockOutcome !== "failed") {
  throw new Error("MOCK_TRAINING_OUTCOME must be 'succeeded' or 'failed'");
}
const datasetRequest = {
  name: "Mock energy predictor",
  sourceTable: "energy_readings",
  features: [
    { name: "temperature", description: "Outside temperature", unit: "celsius" },
    { name: "occupancy", description: "Number of occupants", unit: "people" },
  ],
  target: {
    name: "energy_usage",
    description: "Building energy consumption",
    unit: "kWh",
  },
  timeColumn: { name: "recorded_at", description: "Measurement time" },
};

FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
);
FormatRegistry.Set("date-time", (value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value),
);

assertContract(CreateDatasetDefinitionDto, datasetRequest, "dataset request");
const digest = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const pool = new Pool({ connectionString: databaseUrl });

try {
  const tenantResult = await pool.query<{ schema_name: string }>(
    "SELECT schema_name FROM main.tenants WHERE subdomain = $1 AND status = 'active'",
    [subdomain],
  );
  const schemaName = tenantResult.rows[0]?.schema_name;

  if (!schemaName) throw new Error(`Active tenant '${subdomain}' was not found`);
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Unsafe PostgreSQL schema identifier: ${schemaName}`);
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${schemaName}"`);

    const dataset = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO dataset_definitions
        (name, source_schema, source_table, target_column, time_column)
       VALUES ($1, $2, 'energy_readings', 'energy_usage', 'recorded_at')
       RETURNING id, created_at`,
      [datasetRequest.name, schemaName],
    );
    const storedDataset = requiredRow(dataset, "dataset definition");
    const datasetDefinitionId = storedDataset.id;
    const columns = await client.query<{
      id: string;
      column_name: string;
      role: "feature" | "target" | "time";
      data_type: "number" | "integer" | "datetime";
      description: string;
      unit: string | null;
      is_nullable: boolean;
      position: number;
    }>(
      `INSERT INTO dataset_columns
        (dataset_definition_id, column_name, role, data_type, description, unit, is_nullable, position)
       VALUES
        ($1, 'temperature', 'feature', 'number', 'Outside temperature', 'celsius', false, 0),
        ($1, 'occupancy', 'feature', 'integer', 'Number of occupants', 'people', false, 1),
        ($1, 'energy_usage', 'target', 'number', 'Building energy consumption', 'kWh', false, 2),
        ($1, 'recorded_at', 'time', 'datetime', 'Measurement time', NULL, false, 3)
       RETURNING id, column_name, role, data_type, description, unit, is_nullable, position`,
      [datasetDefinitionId],
    );
    assertContract(
      DatasetDefinitionResponseDto,
      {
        id: datasetDefinitionId,
        name: datasetRequest.name,
        sourceTable: datasetRequest.sourceTable,
        targetColumn: datasetRequest.target.name,
        timeColumn: datasetRequest.timeColumn.name,
        columns: columns.rows.map((column) => ({
          id: column.id,
          name: column.column_name,
          role: column.role,
          dataType: column.data_type,
          description: column.description,
          unit: column.unit,
          isNullable: column.is_nullable,
          position: column.position,
        })),
        createdAt: storedDataset.created_at.toISOString(),
      },
      "dataset response",
    );
    assertContract(
      CreateTrainingJobDto,
      { datasetDefinitionId },
      "training request",
    );

    const snapshotStorageUri = `artifacts/mock-${crypto.randomUUID()}.parquet`;
    const snapshotDigest = digest();
    const snapshotRowCount = 100;
    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO dataset_snapshots
        (dataset_definition_id, storage_uri, storage_format, content_sha256, row_count, schema_summary, frozen_at)
       VALUES ($1, $2, 'parquet', $3, 100, $4, now())
       RETURNING id`,
      [
        datasetDefinitionId,
        snapshotStorageUri,
        snapshotDigest,
        JSON.stringify({ features: ["temperature", "occupancy"], target: "energy_usage" }),
      ],
    );
    const datasetSnapshotId = requiredRow(snapshot, "dataset snapshot").id;

    const fingerprint = digest();
    const trainingConfig = {
      trainerVersion: "mock-1.0.0",
      algorithmPolicy: "automatic-regression" as const,
      randomSeed: 42,
      splitStrategy: "chronological" as const,
      testFraction: 0.2,
      maxRuntimeSeconds: 60,
    };
    const job = await client.query<{ id: string; queued_at: Date }>(
      `INSERT INTO training_jobs
        (dataset_snapshot_id, fingerprint, status, training_config, progress_percent,
         progress_message, queued_at, max_runtime_seconds)
       VALUES ($1, $2, 'queued', $3, 0, 'Waiting for mock worker', now(), 60)
       RETURNING id, queued_at`,
      [
        datasetSnapshotId,
        fingerprint,
        JSON.stringify(trainingConfig),
      ],
    );
    const trainingJob = requiredRow(job, "training job");
    const trainingJobId = trainingJob.id;
    assertContract(
      TrainingJobResponseDto,
      {
        id: trainingJobId,
        datasetSnapshotId,
        fingerprint,
        status: "queued",
        trainingConfig,
        progressPercent: 0,
        progressMessage: "Waiting for mock worker",
        queuedAt: trainingJob.queued_at.toISOString(),
        startedAt: null,
        heartbeatAt: null,
        finishedAt: null,
        error: null,
      },
      "queued training-job response",
    );

    const claimed = await client.query(
      `UPDATE training_jobs
       SET status = 'running', claimed_by = $2, started_at = now(), heartbeat_at = now(),
           progress_percent = 50, progress_message = 'Mock training in progress', updated_at = now()
       WHERE id = $1 AND status = 'queued'
       RETURNING id`,
      [trainingJobId, workerId],
    );
    if (claimed.rowCount !== 1) throw new Error("Mock worker could not claim the job");

    const workerInput = {
      tenantSchema: schemaName,
      jobId: trainingJobId,
      jobFingerprint: fingerprint,
      datasetDefinitionId,
      snapshot: {
        id: datasetSnapshotId,
        storageUri: snapshotStorageUri,
        format: "parquet" as const,
        contentSha256: snapshotDigest,
        rowCount: snapshotRowCount,
      },
      features: [
        { name: "temperature", dataType: "number" as const, position: 0 },
        { name: "occupancy", dataType: "integer" as const, position: 1 },
      ],
      target: { name: "energy_usage", dataType: "number" as const },
      timeColumn: "recorded_at",
      trainingConfig,
      artifactOutputDirectory: process.env.ARTIFACT_STORAGE_PATH ?? "./artifacts",
      heartbeatIntervalSeconds: 10,
    };
    assertContract(TrainingWorkerInputDto, workerInput, "worker input");

    const workerResult = {
      jobId: workerInput.jobId,
      jobFingerprint: workerInput.jobFingerprint,
      workerId,
      result: mockOutcome === "succeeded" ? {
        status: "succeeded" as const,
        metrics: { mae: 2.1, rmse: 2.8, r2: 0.91 },
        baselineMetrics: { mae: 6.4, rmse: 8.2, r2: 0.22 },
        artifact: {
          storageUri: `artifacts/mock-${trainingJobId}.onnx`,
          format: "onnx" as const,
          contentSha256: digest(),
          sizeBytes: 1024,
        },
        features: [
          {
            name: "temperature",
            position: 0,
            dataType: "number" as const,
            validMin: -20,
            validMax: 50,
            allowedValues: null,
            missingRate: 0,
          },
          {
            name: "occupancy",
            position: 1,
            dataType: "integer" as const,
            validMin: 0,
            validMax: 500,
            allowedValues: null,
            missingRate: 0,
          },
        ],
      } : {
        status: "failed" as const,
        error: {
          code: "MOCK_TRAINING_REJECTED",
          message: "The mock worker rejected the training job.",
        },
      },
    };
    assertContract(TrainingWorkerResultDto, workerResult, "worker result");

    let modelVersionId: string | null = null;

    if (workerResult.result.status === "succeeded") {
      const model = await client.query<{ id: string }>(
        `INSERT INTO model_versions
          (dataset_definition_id, training_job_id, version_number, status, metrics, baseline_metrics)
         VALUES ($1, $2, 1, 'candidate', $3, $4)
         RETURNING id`,
        [
          datasetDefinitionId,
          trainingJobId,
          JSON.stringify(workerResult.result.metrics),
          JSON.stringify(workerResult.result.baselineMetrics),
        ],
      );
      modelVersionId = requiredRow(model, "model version").id;

      await client.query(
        `INSERT INTO model_artifacts
          (model_version_id, storage_uri, format, content_sha256, size_bytes, producer_worker_id, produced_at)
         VALUES ($1, $2, 'onnx', $3, $4, $5, now())`,
        [
          modelVersionId,
          workerResult.result.artifact.storageUri,
          workerResult.result.artifact.contentSha256,
          workerResult.result.artifact.sizeBytes,
          workerResult.workerId,
        ],
      );

      for (const feature of workerResult.result.features) {
        const requestFeature = datasetRequest.features[feature.position];
        if (!requestFeature) throw new Error(`Missing request feature at position ${feature.position}`);

        await client.query(
          `INSERT INTO model_features
            (model_version_id, column_name, position, data_type, description, unit,
             is_required, valid_min, valid_max, allowed_values, missing_rate)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10)`,
          [
            modelVersionId,
            feature.name,
            feature.position,
            feature.dataType,
            requestFeature.description,
            requestFeature.unit ?? null,
            feature.validMin,
            feature.validMax,
            feature.allowedValues ? JSON.stringify(feature.allowedValues) : null,
            feature.missingRate,
          ],
        );
      }

      await updateJob(
        client,
        trainingJobId,
        workerId,
        "succeeded",
        "Mock training completed",
      );
    } else {
      await updateJob(
        client,
        trainingJobId,
        workerId,
        "failed",
        workerResult.result.error.message,
        workerResult.result.error,
      );
    }

    await client.query("COMMIT");
    console.log(`Mock training flow completed with status: ${mockOutcome}`);
    console.table({ schemaName, datasetDefinitionId, datasetSnapshotId, trainingJobId, modelVersionId });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}

function requiredRow<T extends pg.QueryResultRow>(
  result: pg.QueryResult<T>,
  recordName: string,
): T {
  const row = result.rows[0];
  if (!row) throw new Error(`Failed to create ${recordName}`);
  return row;
}

async function updateJob(
  client: pg.PoolClient,
  jobId: string,
  claimedBy: string,
  status: "succeeded" | "failed",
  message: string,
  error: { code: string; message: string } | null = null,
): Promise<void> {
  const updated = await client.query(
    `UPDATE training_jobs
     SET status = $3::varchar,
         progress_percent = CASE WHEN $3::varchar = 'succeeded' THEN 100 ELSE progress_percent END,
         progress_message = $4,
         error_code = $5,
         error_message = $6,
         heartbeat_at = now(),
         finished_at = now(),
         updated_at = now()
     WHERE id = $1 AND status = 'running' AND claimed_by = $2
     RETURNING id`,
    [jobId, claimedBy, status, message, error?.code ?? null, error?.message ?? null],
  );
  if (updated.rowCount !== 1) throw new Error(`Mock worker could not mark the job ${status}`);
}

function assertContract(schema: TSchema, value: unknown, label: string): void {
  if (Value.Check(schema, value)) {
    console.log(`PASS contract validation: ${label}`);
    return;
  }

  const errors = [...Value.Errors(schema, value)]
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}: ${errors}`);
}
