import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { hash, secondUuid, timestamp, uuid } from "../test-support";
import {
  CreateTrainingJobDto,
  ResolvedTrainingConfigDto,
  TrainingJobResponseDto,
  TrainingWorkerInputDto,
  TrainingWorkerResultDto,
} from "./index";

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

  it("rejects invalid job requests and malformed worker results", () => {
    expect(
      Value.Check(CreateTrainingJobDto, { datasetDefinitionId: "nope" }),
    ).toBe(false);
    expect(
      Value.Check(CreateTrainingJobDto, {
        datasetDefinitionId: uuid,
        unexpected: true,
      }),
    ).toBe(false);
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
