import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  CreateDatasetDefinitionDto,
  CreateTrainingJobDto,
  DatasetDefinitionErrorDto,
  DatasetDefinitionResponseDto,
  GeneratedToolDefinitionDto,
  PredictionRejectedResponseDto,
  PredictionRequestDto,
  PredictionResponseDto,
  PredictionSuccessResponseDto,
  ResolvedTrainingConfigDto,
  TrainingJobResponseDto,
  TrainingWorkerInputDto,
  TrainingWorkerResultDto,
} from "./index";

FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  ),
);
FormatRegistry.Set("date-time", (value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value,
  ),
);

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const secondUuid = "123e4567-e89b-42d3-a456-426614174001";
const hash = "a".repeat(64);
const timestamp = "2026-08-04T08:00:00Z";

const trainingConfig = {
  trainerVersion: "1.0.0",
  algorithmPolicy: "automatic-regression",
  randomSeed: 42,
  splitStrategy: "chronological",
  testFraction: 0.2,
  maxRuntimeSeconds: 300,
};

const workerFeature = {
  name: "temperature",
  position: 0,
  dataType: "number",
  validMin: -20,
  validMax: 50,
  allowedValues: null,
  missingRate: 0.01,
};

const workerSuccess = {
  jobId: uuid,
  jobFingerprint: hash,
  workerId: "worker-1",
  result: {
    status: "succeeded",
    metrics: { mae: 1, rmse: 1.2, r2: 0.9 },
    baselineMetrics: { mae: 2, rmse: 2.2, r2: 0.5 },
    artifact: {
      storageUri: "artifacts/model.onnx",
      format: "onnx",
      contentSha256: hash,
      sizeBytes: 1024,
    },
    features: [workerFeature],
  },
};

const workerFailure = {
  jobId: uuid,
  jobFingerprint: hash,
  workerId: "worker-1",
  result: {
    status: "failed",
    error: { code: "TRAINING_FAILED", message: "Training failed" },
  },
};

const outputSchema = {
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
};

const predictionBase = {
  modelVersionId: uuid,
  modelVersion: 1,
  warnings: [],
};

describe("dataset contracts", () => {
  it("accepts valid requests, responses, and structured errors", () => {
    expect(
      Value.Check(CreateDatasetDefinitionDto, {
        name: "Energy predictor",
        sourceTable: "energy_readings",
        features: [{ name: "temperature", description: "Temperature" }],
        target: { name: "energy_usage", description: "Energy", unit: "kWh" },
        timeColumn: { name: "recorded_at", description: "Recorded time" },
      }),
    ).toBe(true);
    expect(
      Value.Check(DatasetDefinitionResponseDto, {
        id: uuid,
        name: "Energy predictor",
        sourceTable: "energy_readings",
        targetColumn: "energy_usage",
        timeColumn: "recorded_at",
        columns: [
          {
            id: secondUuid,
            name: "temperature",
            role: "feature",
            dataType: "number",
            description: "Temperature",
            unit: null,
            isNullable: false,
            position: 0,
          },
        ],
        createdAt: timestamp,
      }),
    ).toBe(true);
    expect(
      Value.Check(DatasetDefinitionErrorDto, {
        error: {
          code: "COLUMN_NOT_FOUND",
          message: "Column was not found",
          issues: [{ path: "features.0", message: "Unknown column" }],
        },
      }),
    ).toBe(true);
  });

  it("rejects invalid identifiers, UUIDs, and extra properties", () => {
    expect(
      Value.Check(CreateDatasetDefinitionDto, {
        name: "Energy predictor",
        sourceTable: "public.energy_readings",
        features: [{ name: "temperature", description: "Temperature" }],
        target: { name: "energy_usage", description: "Energy" },
      }),
    ).toBe(false);
    expect(Value.Check(CreateTrainingJobDto, { datasetDefinitionId: "nope" })).toBe(
      false,
    );
    expect(
      Value.Check(CreateTrainingJobDto, {
        datasetDefinitionId: uuid,
        unexpected: true,
      }),
    ).toBe(false);
  });
});

describe("training contracts", () => {
  it("accepts valid training configuration, job, and worker input", () => {
    expect(Value.Check(ResolvedTrainingConfigDto, trainingConfig)).toBe(true);
    expect(
      Value.Check(TrainingJobResponseDto, {
        id: uuid,
        datasetSnapshotId: secondUuid,
        fingerprint: hash,
        status: "queued",
        trainingConfig,
        progressPercent: 0,
        progressMessage: null,
        queuedAt: timestamp,
        startedAt: null,
        heartbeatAt: null,
        finishedAt: null,
        error: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(TrainingWorkerInputDto, {
        tenantSchema: "tenant_acme",
        jobId: uuid,
        jobFingerprint: hash,
        datasetDefinitionId: secondUuid,
        snapshot: {
          id: secondUuid,
          storageUri: "snapshots/data.parquet",
          format: "parquet",
          contentSha256: hash,
          rowCount: 100,
        },
        features: [{ name: "temperature", dataType: "number", position: 0 }],
        target: { name: "energy_usage", dataType: "number" },
        timeColumn: "recorded_at",
        trainingConfig,
        artifactOutputDirectory: "artifacts",
        heartbeatIntervalSeconds: 10,
      }),
    ).toBe(true);
  });

  it("accepts both worker-result branches", () => {
    expect(Value.Check(TrainingWorkerResultDto, workerSuccess)).toBe(true);
    expect(Value.Check(TrainingWorkerResultDto, workerFailure)).toBe(true);
  });

  it("rejects malformed hashes, bounds, extra fields, and mixed result branches", () => {
    expect(
      Value.Check(TrainingWorkerResultDto, {
        ...workerSuccess,
        jobFingerprint: "ABC",
      }),
    ).toBe(false);
    expect(
      Value.Check(TrainingWorkerResultDto, {
        ...workerSuccess,
        result: { ...workerSuccess.result, extra: true },
      }),
    ).toBe(false);
    expect(
      Value.Check(TrainingWorkerResultDto, {
        ...workerSuccess,
        result: {
          ...workerSuccess.result,
          features: [{ ...workerFeature, missingRate: 2 }],
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(TrainingWorkerResultDto, {
        ...workerSuccess,
        result: { ...workerSuccess.result, error: workerFailure.result.error },
      }),
    ).toBe(false);
    expect(
      Value.Check(ResolvedTrainingConfigDto, {
        ...trainingConfig,
        testFraction: 1,
      }),
    ).toBe(false);
  });
});

describe("generated tool definition", () => {
  const definition = {
    modelVersionId: uuid,
    toolName: "predict_energy_usage",
    description: "Predict energy usage",
    generatorVersion: "1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        temperature: {
          type: "number",
          description: "Temperature",
          minimum: -20,
          maximum: 50,
        },
      },
      required: ["temperature"],
      additionalProperties: false,
    },
    outputSchema,
  };

  it("accepts a complete generated definition", () => {
    expect(Value.Check(GeneratedToolDefinitionDto, definition)).toBe(true);
  });

  it("rejects invalid model IDs, duplicate required fields, and extra properties", () => {
    expect(
      Value.Check(GeneratedToolDefinitionDto, {
        ...definition,
        modelVersionId: "not-a-uuid",
      }),
    ).toBe(false);
    expect(
      Value.Check(GeneratedToolDefinitionDto, {
        ...definition,
        inputSchema: {
          ...definition.inputSchema,
          required: ["temperature", "temperature"],
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(GeneratedToolDefinitionDto, { ...definition, draft: true }),
    ).toBe(false);
  });
});

describe("prediction contracts", () => {
  const success = {
    ...predictionBase,
    outcome: "prediction",
    prediction: 42.5,
    uncertainty: 0.2,
    rejection: null,
  };
  const rejected = {
    ...predictionBase,
    outcome: "rejected",
    prediction: null,
    uncertainty: null,
    rejection: {
      code: "OUT_OF_RANGE",
      message: "Temperature is outside the supported range",
      fields: [{ name: "temperature", message: "Must be at most 50" }],
    },
  };

  it("accepts requests and both consistent response branches", () => {
    expect(
      Value.Check(PredictionRequestDto, {
        toolName: "predict_energy_usage",
        conversationId: "conversation-1",
        inputs: { temperature: 22, occupied: true },
      }),
    ).toBe(true);
    expect(Value.Check(PredictionSuccessResponseDto, success)).toBe(true);
    expect(Value.Check(PredictionRejectedResponseDto, rejected)).toBe(true);
    expect(Value.Check(PredictionResponseDto, success)).toBe(true);
    expect(Value.Check(PredictionResponseDto, rejected)).toBe(true);
  });

  it("rejects malformed requests and inconsistent response branches", () => {
    expect(
      Value.Check(PredictionRequestDto, {
        toolName: "predict_energy_usage",
        inputs: { nested: { value: 22 } },
      }),
    ).toBe(false);
    expect(
      Value.Check(PredictionRequestDto, {
        toolName: "predict_energy_usage",
        inputs: {},
        modelVersion: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(PredictionResponseDto, {
        ...success,
        outcome: "rejected",
      }),
    ).toBe(false);
    expect(
      Value.Check(PredictionResponseDto, {
        ...rejected,
        prediction: 42.5,
      }),
    ).toBe(false);
    expect(
      Value.Check(PredictionRejectedResponseDto, {
        ...rejected,
        rejection: { ...rejected.rejection, code: "UNKNOWN_CODE" },
      }),
    ).toBe(false);
    expect(
      Value.Check(PredictionSuccessResponseDto, {
        ...success,
        uncertainty: -0.1,
      }),
    ).toBe(false);
  });
});
