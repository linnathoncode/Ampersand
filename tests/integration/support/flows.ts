import type pg from "pg";

import {
  CreateDatasetDefinitionDto,
  CreateTrainingJobDto,
  DatasetDefinitionResponseDto,
  GeneratedToolDefinitionDto,
  PredictionRequestDto,
  PredictionResponseDto,
  PredictionSuccessResponseDto,
  TrainingJobResponseDto,
  TrainingWorkerInputDto,
  TrainingWorkerResultDto,
  type GeneratedToolDefinition,
  type PredictionRequest,
  type PredictionSuccessResponse,
  type TrainingWorkerInput,
  type TrainingWorkerResult,
} from "@ampersand/contracts";

import { assertContract, datasetRequest, trainingConfig } from "./contracts";

export const WORKER_ID = "mock-worker";

export interface TrainingFlowResult {
  datasetDefinitionId: string;
  datasetSnapshotId: string;
  trainingJobId: string;
  modelVersionId: string | null;
  workerInput: TrainingWorkerInput;
  workerResult: TrainingWorkerResult;
}

export async function runTrainingFlow(
  client: pg.PoolClient,
  options: { outcome: "succeeded" | "failed"; schemaName: string },
): Promise<TrainingFlowResult> {
  const { outcome, schemaName } = options;
  if (outcome !== "succeeded" && outcome !== "failed") {
    throw new Error("outcome must be 'succeeded' or 'failed'");
  }

  assertContract(CreateDatasetDefinitionDto, datasetRequest, "dataset request");

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
  const job = await client.query<{ id: string; queued_at: Date }>(
    `INSERT INTO training_jobs
      (dataset_snapshot_id, fingerprint, status, training_config, progress_percent,
       progress_message, queued_at, max_runtime_seconds)
     VALUES ($1, $2, 'queued', $3, 0, 'Waiting for mock worker', now(), 60)
     RETURNING id, queued_at`,
    [datasetSnapshotId, fingerprint, JSON.stringify(trainingConfig)],
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
    [trainingJobId, WORKER_ID],
  );
  if (claimed.rowCount !== 1) throw new Error("Mock worker could not claim the job");

  const workerInput: TrainingWorkerInput = {
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

  const workerResult: TrainingWorkerResult = {
    jobId: workerInput.jobId,
    jobFingerprint: workerInput.jobFingerprint,
    workerId: WORKER_ID,
    result:
      outcome === "succeeded"
        ? {
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
            splitMetadata: {
              strategy: "chronological" as const,
              timeColumn: workerInput.timeColumn,
              trainRowCount: 80,
              testRowCount: 20,
              testFraction: workerInput.trainingConfig.testFraction,
              roundingRule:
                "round(rowCount * testFraction), clamped so both partitions keep at least one row",
              trainingBoundary: "2026-08-04T07:59:59.000Z",
              testStart: "2026-08-04T08:00:00.000Z",
              randomSeed: workerInput.trainingConfig.randomSeed,
              featureOrder: ["temperature", "occupancy"],
              trainerVersion: workerInput.trainingConfig.trainerVersion,
              dependencyVersions: {
                python: "3.11.4",
                pyarrow: "16.0.0",
                pydantic: "2.7.0",
              },
            },
          }
        : {
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
      if (!requestFeature) {
        throw new Error(`Missing request feature at position ${feature.position}`);
      }
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

    await updateJob(client, trainingJobId, "succeeded", "Mock training completed");
  } else {
    await updateJob(
      client,
      trainingJobId,
      "failed",
      workerResult.result.error.message,
      workerResult.result.error,
    );
  }

  return {
    datasetDefinitionId,
    datasetSnapshotId,
    trainingJobId,
    modelVersionId,
    workerInput,
    workerResult,
  };
}

export interface GeneratedTool {
  modelVersionId: string;
  versionNumber: number;
  toolName: string;
  toolDefinition: GeneratedToolDefinition;
  toolDefinitionId: string;
}

export async function publishAndGenerateTool(
  client: pg.PoolClient,
  options: { modelVersionId: string; versionNumber: number },
): Promise<GeneratedTool> {
  const { modelVersionId, versionNumber } = options;

  await client.query(
    `UPDATE model_versions
     SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now()
     WHERE id = $1`,
    [modelVersionId],
  );

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const toolName = `predict_energy_usage_${suffix}`;
  const toolDefinition: GeneratedToolDefinition = {
    modelVersionId,
    toolName,
    description: "Predict building energy usage from temperature and occupancy.",
    generatorVersion: "mock-1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        temperature: {
          type: "number",
          description: "Outside temperature in celsius.",
          minimum: -20,
          maximum: 50,
        },
        occupancy: {
          type: "integer",
          description: "Number of occupants.",
          minimum: 0,
          maximum: 500,
        },
      },
      required: ["temperature", "occupancy"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        outcome: { enum: ["prediction", "rejected"] },
        prediction: { type: ["number", "null"] },
        uncertainty: { type: ["number", "null"] },
        modelVersion: { type: "integer" },
        warnings: { type: "array", items: { type: "string" } },
        rejection: { type: ["object", "null"] },
      },
      required: [
        "outcome",
        "prediction",
        "uncertainty",
        "modelVersion",
        "warnings",
        "rejection",
      ],
      additionalProperties: false,
    },
  };
  assertContract(GeneratedToolDefinitionDto, toolDefinition, "generated tool definition");

  const storedTool = await client.query<{ id: string }>(
    `INSERT INTO tool_definitions
      (model_version_id, tool_name, description, input_schema, output_schema,
       generator_version, schema_sha256, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING id`,
    [
      toolDefinition.modelVersionId,
      toolDefinition.toolName,
      toolDefinition.description,
      JSON.stringify(toolDefinition.inputSchema),
      JSON.stringify(toolDefinition.outputSchema),
      toolDefinition.generatorVersion,
      digest(),
    ],
  );
  const toolDefinitionId = requiredRow(storedTool, "tool definition").id;

  return { modelVersionId, versionNumber, toolName, toolDefinition, toolDefinitionId };
}

export interface RunPredictionOptions {
  toolDefinitionId: string;
  modelVersionId: string;
  versionNumber: number;
  toolDefinition: GeneratedToolDefinition;
  request: unknown;
}

export interface PredictionResult {
  predictionResponse: PredictionSuccessResponse;
  inferenceCallId: string;
}

export async function runPrediction(
  client: pg.PoolClient,
  options: RunPredictionOptions,
): Promise<PredictionResult> {
  const { toolDefinitionId, modelVersionId, versionNumber, toolDefinition, request } =
    options;

  assertContract(PredictionRequestDto, request, "prediction request");
  const validRequest = request as PredictionRequest;
  validateGeneratedInputs(validRequest, toolDefinition);

  const predictionResponse: PredictionSuccessResponse = {
    outcome: "prediction",
    prediction: 48.4,
    uncertainty: 1.3,
    modelVersionId,
    modelVersion: versionNumber,
    warnings: [],
    rejection: null,
  };
  assertContract(
    PredictionSuccessResponseDto,
    predictionResponse,
    "successful prediction response",
  );
  assertContract(
    PredictionResponseDto,
    predictionResponse,
    "prediction response union",
  );

  const inference = await client.query<{ id: string }>(
    `INSERT INTO inference_calls
      (tool_definition_id, model_version_id, conversation_id, input_payload, outcome,
       prediction, uncertainty, warnings, latency_ms)
     VALUES ($1, $2, $3, $4, 'prediction', $5, $6, $7, 8)
     RETURNING id`,
    [
      toolDefinitionId,
      modelVersionId,
      validRequest.conversationId ?? null,
      JSON.stringify(validRequest.inputs),
      predictionResponse.prediction,
      predictionResponse.uncertainty,
      JSON.stringify(predictionResponse.warnings),
    ],
  );
  const inferenceCallId = requiredRow(inference, "inference call").id;

  return { predictionResponse, inferenceCallId };
}

function validateGeneratedInputs(
  request: PredictionRequest,
  toolDefinition: GeneratedToolDefinition,
): void {
  const schema = toolDefinition.inputSchema;
  const unknown = Object.keys(request.inputs).filter(
    (name) => !(name in schema.properties),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown tool inputs: ${unknown.join(", ")}`);
  }
  for (const name of schema.required) {
    if (!(name in request.inputs)) {
      throw new Error(`Missing tool input: ${name}`);
    }
  }
  for (const [name, value] of Object.entries(request.inputs)) {
    const property = schema.properties[name];
    if (!property) throw new Error(`Unknown tool input: ${name}`);
    switch (property.type) {
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`${name} must be a number`);
        }
        break;
      case "integer":
        if (!Number.isInteger(value)) {
          throw new Error(`${name} must be an integer`);
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new Error(`${name} must be a boolean`);
        }
        break;
      case "string":
        if (typeof value !== "string") {
          throw new Error(`${name} must be a string`);
        }
        break;
    }
    if (typeof value === "number") {
      if (property.minimum !== undefined && value < property.minimum) {
        throw new Error(`${name} must be at least ${property.minimum}`);
      }
      if (property.maximum !== undefined && value > property.maximum) {
        throw new Error(`${name} must be at most ${property.maximum}`);
      }
    }
  }
}

async function updateJob(
  client: pg.PoolClient,
  jobId: string,
  status: "succeeded" | "failed",
  message: string,
  error: { code: string; message: string } | null = null,
): Promise<void> {
  const updated = await client.query(
    `UPDATE training_jobs
     SET status = $2::varchar,
         progress_percent = CASE WHEN $2::varchar = 'succeeded' THEN 100 ELSE progress_percent END,
         progress_message = $3,
         error_code = $4,
         error_message = $5,
         heartbeat_at = now(),
         finished_at = now(),
         updated_at = now()
     WHERE id = $1 AND status = 'running' AND claimed_by = $6
     RETURNING id`,
    [jobId, status, message, error?.code ?? null, error?.message ?? null, WORKER_ID],
  );
  if (updated.rowCount !== 1) {
    throw new Error(`Mock worker could not mark the job ${status}`);
  }
}

function requiredRow<T extends pg.QueryResultRow>(
  result: pg.QueryResult<T>,
  recordName: string,
): T {
  const row = result.rows[0];
  if (!row) throw new Error(`Failed to create ${recordName}`);
  return row;
}

function digest(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
