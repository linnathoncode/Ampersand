import { describe, expect, test } from "bun:test";

import type { CreateTrainingJobInput, ResolvedTrainingConfig } from "@ampersand/contracts";

import type {
  LoadedDatasetColumn,
  LoadedDatasetDefinition,
} from "../dataset/repository";
import {
  createTrainingJob,
  validateDatasetTrainability,
  type TrainingJobRepository,
} from "./service";

const datasetDefinitionId = "11111111-1111-4111-8111-111111111111";
const snapshotId = "22222222-2222-4222-8222-222222222222";
const schemaName = "tenant_ampersand_dev";
const userId = "33333333-3333-4333-8333-333333333333";

const definition: LoadedDatasetDefinition = {
  id: datasetDefinitionId,
  name: "Energy predictor",
  sourceSchema: schemaName,
  sourceTable: "energy_readings",
  createdBy: userId,
};

const columns: LoadedDatasetColumn[] = [
  { name: "temperature", role: "feature", dataType: "number", isNullable: false, position: 0 },
  { name: "occupancy", role: "feature", dataType: "integer", isNullable: true, position: 1 },
  { name: "energy_usage", role: "target", dataType: "number", isNullable: false, position: 2 },
  { name: "recorded_at", role: "time", dataType: "datetime", isNullable: false, position: 3 },
];

function createInput(overrides: Partial<CreateTrainingJobInput> = {}): CreateTrainingJobInput {
  return { datasetDefinitionId, ...overrides };
}

function createRepository(overrides: Partial<TrainingJobRepository> = {}): TrainingJobRepository {
  return {
    loadDatasetDefinition: async () => definition,
    loadDatasetColumns: async () => columns,
    loadLatestValidSnapshot: async () => ({
      id: snapshotId,
      storageUri: "snapshots/data.parquet",
      contentSha256: "a".repeat(64),
      rowCount: 100,
    }),
    lockTrainingSubmissionQuota: async () => {},
    countActiveTrainingJobs: async () => 0,
    insertTrainingJob: async (input) => ({
      id: "44444444-4444-4444-8444-444444444444",
      queuedAt: new Date("2026-08-12T08:00:00.000Z"),
    }),
    ...overrides,
  };
}

describe("validateDatasetTrainability", () => {
  test("accepts features, target, and optional time column", () => {
    expect(validateDatasetTrainability(columns)).toEqual([]);
  });

  test("rejects a definition with no columns", () => {
    expect(validateDatasetTrainability([])).toHaveLength(1);
  });

  test("rejects a definition without features", () => {
    const issues = validateDatasetTrainability(
      columns.filter((column) => column.role !== "feature"),
    );

    expect(issues).toContain("At least one feature column is required");
  });

  test("rejects a definition without a target", () => {
    const issues = validateDatasetTrainability(
      columns.filter((column) => column.role !== "target"),
    );

    expect(issues).toContain("Exactly one target column is required");
  });

  test("rejects multiple targets", () => {
    const issues = validateDatasetTrainability([
      ...columns,
      { name: "second_target", role: "target", dataType: "integer", isNullable: false, position: 4 },
    ]);

    expect(issues).toContain("Only one target column is allowed");
  });

  test("rejects a non-numeric target", () => {
    const issues = validateDatasetTrainability(
      columns.map((column) =>
        column.role === "target" ? { ...column, dataType: "category" as const } : column,
      ),
    );

    expect(issues).toContain("The target column must have a numeric type");
  });
});

describe("createTrainingJob", () => {
  test("creates a queued job with server-controlled configuration", async () => {
    const inserted: Parameters<TrainingJobRepository["insertTrainingJob"]>[0][] = [];
    const repository = createRepository({
      insertTrainingJob: async (input) => {
        inserted.push(input);
        return {
          id: "44444444-4444-4444-8444-444444444444",
          queuedAt: new Date("2026-08-12T08:00:00.000Z"),
        };
      },
    });

    const result = await createTrainingJob(repository, schemaName, userId, createInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful creation");

    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      datasetSnapshotId: snapshotId,
      status: "queued",
      progressPercent: 0,
      progressMessage: "Waiting for a worker",
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
      error: null,
    });
    expect(result.body.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      datasetSnapshotId: snapshotId,
      maxRuntimeSeconds: 600,
      createdBy: userId,
    });
    expect(inserted[0]!.trainingConfig).toEqual({
      trainerVersion: "1.0.0",
      algorithmPolicy: "automatic-regression",
      randomSeed: 42,
      splitStrategy: "chronological",
      testFraction: 0.2,
      maxRuntimeSeconds: 600,
    });
  });

  test("rejects a missing dataset definition", async () => {
    const result = await createTrainingJob(
      createRepository({ loadDatasetDefinition: async () => null }),
      schemaName,
      userId,
      createInput(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("DATASET_DEFINITION_NOT_FOUND");
  });

  test("rejects a dataset definition owned by another tenant", async () => {
    const result = await createTrainingJob(
      createRepository({
        loadDatasetDefinition: async () => ({
          ...definition,
          sourceSchema: "tenant_other",
        }),
      }),
      schemaName,
      userId,
      createInput(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("DATASET_DEFINITION_NOT_FOUND");
  });

  test("rejects a definition that cannot be trained", async () => {
    const result = await createTrainingJob(
      createRepository({
        loadDatasetColumns: async () =>
          columns.filter((column) => column.role !== "target"),
      }),
      schemaName,
      userId,
      createInput(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(422);
    expect(result.body.error.code).toBe("DATASET_NOT_TRAINABLE");
  });

  test("rejects a definition without a snapshot", async () => {
    const result = await createTrainingJob(
      createRepository({ loadLatestValidSnapshot: async () => null }),
      schemaName,
      userId,
      createInput(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("SNAPSHOT_NOT_FOUND");
  });

  test("rejects a request when the tenant quota is reached", async () => {
    const result = await createTrainingJob(
      createRepository({ countActiveTrainingJobs: async () => 5 }),
      schemaName,
      userId,
      createInput(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(429);
    expect(result.body.error.code).toBe("TRAINING_QUOTA_EXCEEDED");
  });

  test("acquires the tenant quota lock before counting active jobs", async () => {
    const steps: string[] = [];
    let acquired = false;
    let counted = false;

    const repository = createRepository({
      lockTrainingSubmissionQuota: async (tenantSchema) => {
        expect(tenantSchema).toBe(schemaName);
        acquired = true;
        steps.push("lock");
      },
      countActiveTrainingJobs: async () => {
        counted = true;
        steps.push("count");
        return 0;
      },
    });

    const result = await createTrainingJob(repository, schemaName, userId, createInput());

    expect(result.ok).toBe(true);
    expect(acquired).toBe(true);
    expect(counted).toBe(true);
    expect(steps).toEqual(["lock", "count"]);
  });

  test("rejects a concurrent duplicate with a unique violation", async () => {
    const result = await createTrainingJob(
      createRepository({
        insertTrainingJob: async () => {
          throw { code: "23505", constraint: "training_jobs_fingerprint_key" };
        },
      }),
      schemaName,
      userId,
      createInput(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("DUPLICATE_TRAINING_REQUEST");
  });

  test("rethrows non-duplicate database errors", async () => {
    const repository = createRepository({
      insertTrainingJob: async () => {
        throw new Error("connection lost");
      },
    });

    await expect(
      createTrainingJob(repository, schemaName, userId, createInput()),
    ).rejects.toThrow("connection lost");
  });

  test("uses the same resolved configuration for fingerprint and persistence", async () => {
    let storedConfig: ResolvedTrainingConfig | undefined;
    let storedFingerprint: string | undefined;
    const repository = createRepository({
      insertTrainingJob: async (input) => {
        storedConfig = input.trainingConfig;
        storedFingerprint = input.fingerprint;
        return {
          id: "44444444-4444-4444-8444-444444444444",
          queuedAt: new Date("2026-08-12T08:00:00.000Z"),
        };
      },
    });

    const result = await createTrainingJob(repository, schemaName, userId, createInput());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful creation");
    expect(storedFingerprint).toBe(result.body.fingerprint);
    expect(storedConfig).toEqual(result.body.trainingConfig);
  });
});
