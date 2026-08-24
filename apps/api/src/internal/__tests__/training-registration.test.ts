process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused";

import { describe, expect, test } from "bun:test";
import type { PoolClient, QueryResult } from "pg";

import type { RegisterCandidateInput } from "../training-registration";

const { CandidateRegistrationError, mapUniqueViolation, registerCandidateModel } =
  await import("../training-registration");

type RowMap = Record<string, { rows: unknown[]; rowCount: number | null }>;

function makeClient(script: RowMap, executed: [string, unknown[]][] = []): PoolClient {
  const findResponse = (sql: string) => {
    for (const [fragment, response] of Object.entries(script)) {
      if (sql.includes(fragment)) {
        return response;
      }
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    query: async (sql: string, params?: unknown[]) => {
      executed.push([String(sql), params ?? []]);

      return findResponse(String(sql)) as QueryResult;
    },
  } as unknown as PoolClient;
}

const definitionId = "33333333-3333-4333-8333-333333333333";
const jobId = "11111111-1111-4111-8111-111111111111";

function recordingPromoter(promotedVersions: number[] = []) {
  return async (versionNumber: number) => {
    promotedVersions.push(versionNumber);

    return {
      storageUri: `models/${definitionId}/v${versionNumber}/${jobId}.onnx`,
      absolutePath: `/tmp/artifacts/models/${definitionId}/v${versionNumber}/${jobId}.onnx`,
    };
  };
}

function successInput(
  overrides: Partial<RegisterCandidateInput> = {},
): RegisterCandidateInput {
  return {
    schemaName: "tenant_test",
    jobId,
    jobFingerprint: "a".repeat(64),
    workerId: "worker-a",
    result: {
      status: "succeeded",
      metrics: { mae: 1.5, rmse: 2, r2: 0.8 },
      baselineMetrics: { mae: 5, rmse: 6, r2: 0 },
      artifact: {
        storageUri: "job.onnx.tmp",
        format: "onnx",
        contentSha256: "b".repeat(64),
        sizeBytes: 128,
      },
      features: [
        {
          name: "temperature",
          position: 0,
          dataType: "number",
          validMin: -20,
          validMax: 50,
          allowedValues: null,
          missingRate: 0,
        },
      ],
      splitMetadata: {
        strategy: "chronological",
        timeColumn: "recorded_at",
        trainRowCount: 80,
        testRowCount: 20,
        testFraction: 0.2,
        roundingRule: "round",
        trainingBoundary: null,
        testStart: null,
        randomSeed: 42,
        featureOrder: ["temperature"],
        trainerVersion: "1.0.0",
        dependencyVersions: { python: "3.11" },
      },
    },
    storageRoot: "/tmp/artifacts",
    promote: recordingPromoter(),
    ...overrides,
  };
}

function baseScript(overrides: RowMap = {}): RowMap {
  return {
    "SELECT fingerprint, claimed_by": {
      rows: [
        {
          fingerprint: "a".repeat(64),
          claimed_by: "worker-a",
          status: "running",
        },
      ],
      rowCount: 1,
    },
    "FOR UPDATE OF dd": {
      rows: [{ id: definitionId }],
      rowCount: 1,
    },
    "COALESCE(MAX(version_number)": {
      rows: [{ version_number: 7 }],
      rowCount: 1,
    },
    "INSERT INTO model_versions": {
      rows: [{ id: "model-version-1", version_number: 7 }],
      rowCount: 1,
    },
    "FROM dataset_columns": {
      rows: [
        {
          column_name: "temperature",
          position: 0,
          description: "Air temperature",
          unit: "C",
          is_nullable: false,
        },
      ],
      rowCount: 1,
    },
    "UPDATE training_jobs": { rows: [], rowCount: 1 },
    ...overrides,
  };
}

describe("registerCandidateModel", () => {
  test("allocates the version server-side and persists the final uri", async () => {
    const executed: [string, unknown[]][] = [];
    const promotedVersions: number[] = [];

    const candidate = await registerCandidateModel(
      makeClient(baseScript(), executed),
      successInput({ promote: recordingPromoter(promotedVersions) }),
    );

    expect(promotedVersions).toEqual([7]);
    expect(candidate).toEqual({
      modelVersionId: "model-version-1",
      versionNumber: 7,
      storageUri: `models/${definitionId}/v7/${jobId}.onnx`,
    });

    const versionInsert = executed.find(([sql]) =>
      String(sql).includes("INSERT INTO model_versions"),
    );
    expect(versionInsert?.[1]).toEqual([
      definitionId,
      jobId,
      7,
      JSON.stringify({ mae: 1.5, rmse: 2, r2: 0.8 }),
      JSON.stringify({ mae: 5, rmse: 6, r2: 0 }),
    ]);
  });

  test("writes the version-bearing progress message", async () => {
    const executed: [string, unknown[]][] = [];

    await registerCandidateModel(makeClient(baseScript(), executed), successInput());

    const completionUpdate = executed.find(([sql]) =>
      String(sql).includes("UPDATE training_jobs"),
    );

    expect(completionUpdate?.[1]?.[2]).toBe(
      "Training completed; candidate model version 7 registered",
    );
  });

  test("rejects a fingerprint mismatch before any promotion", async () => {
    const executed: [string, unknown[]][] = [];
    let promoted = false;

    const rejection = registerCandidateModel(
      makeClient(baseScript(), executed),
      successInput({
        jobFingerprint: "c".repeat(64),
        promote: async () => {
          promoted = true;

          return { storageUri: "x", absolutePath: "/tmp/x" };
        },
      }),
    );

    await expect(rejection).rejects.toThrow(CandidateRegistrationError);
    await expect(rejection).rejects.toMatchObject({ code: "JOB_OWNERSHIP" });
    expect(promoted).toBe(false);

    const statements = executed.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("INSERT INTO"))).toBe(false);
  });

  test("rejects an unclaimed job", async () => {
    const rejection = registerCandidateModel(
      makeClient({
        "SELECT fingerprint, claimed_by": {
          rows: [
            {
              fingerprint: "a".repeat(64),
              claimed_by: "worker-b",
              status: "running",
            },
          ],
          rowCount: 1,
        },
      }),
      successInput(),
    );

    await expect(rejection).rejects.toMatchObject({ code: "JOB_OWNERSHIP" });
  });

  test("rejects a terminal job before touching storage", async () => {
    const executed: [string, unknown[]][] = [];
    const rejection = registerCandidateModel(
      makeClient(
        {
          "SELECT fingerprint, claimed_by": {
            rows: [
              {
                fingerprint: "a".repeat(64),
                claimed_by: "worker-a",
                status: "succeeded",
              },
            ],
            rowCount: 1,
          },
        },
        executed,
      ),
      successInput(),
    );

    await expect(rejection).rejects.toMatchObject({
      code: "JOB_STATE_CONFLICT",
    });
    expect(
      executed.some(([sql]) => String(sql).includes("INSERT INTO")),
    ).toBe(false);
  });

  test("rejects when the dataset definition vanished", async () => {
    const rejection = registerCandidateModel(
      makeClient({
        "SELECT fingerprint, claimed_by": {
          rows: [
            {
              fingerprint: "a".repeat(64),
              claimed_by: "worker-a",
              status: "running",
            },
          ],
          rowCount: 1,
        },
        "FOR UPDATE OF dd": { rows: [], rowCount: 0 },
      }),
      successInput(),
    );

    await expect(rejection).rejects.toMatchObject({
      code: "MODEL_FEATURE_METADATA_INVALID",
    });
  });

  test("rejects an empty feature set", async () => {
    const emptyFeatures = successInput();
    emptyFeatures.result.features = [];

    await expect(
      registerCandidateModel(makeClient(baseScript()), emptyFeatures),
    ).rejects.toMatchObject({ code: "MODEL_FEATURE_METADATA_INVALID" });
  });

  test("rejects a feature that does not match trusted columns", async () => {
    const script = baseScript({
      "FROM dataset_columns": {
        rows: [
          {
            column_name: "temperature",
            position: 0,
            description: "Air temperature",
            unit: "C",
            is_nullable: false,
          },
        ],
        rowCount: 1,
      },
    });
    const mismatched = successInput();
    mismatched.result.features = [
      { ...mismatched.result.features[0]!, position: 5 },
    ];

    await expect(
      registerCandidateModel(makeClient(script), mismatched),
    ).rejects.toMatchObject({ code: "MODEL_FEATURE_METADATA_INVALID" });
  });

  test("derives is_required from column nullability", async () => {
    const executed: [string, unknown[]][] = [];
    const script = baseScript({
      "FROM dataset_columns": {
        rows: [
          {
            column_name: "temperature",
            position: 0,
            description: "Air temperature",
            unit: "C",
            is_nullable: true,
          },
        ],
        rowCount: 1,
      },
    });

    await registerCandidateModel(makeClient(script, executed), successInput());

    const featureInsert = executed.find(([sql]) =>
      String(sql).includes("INSERT INTO model_features"),
    );

    expect(featureInsert?.[1]?.[6]).toBe(false);
  });

  test("raises a state conflict when the guarded update misses", async () => {
    const script = baseScript({
      "UPDATE training_jobs": { rows: [], rowCount: 0 },
      "SELECT claimed_by, status": {
        rows: [{ claimed_by: "worker-a", status: "cancelled" }],
        rowCount: 1,
      },
    });

    await expect(
      registerCandidateModel(makeClient(script), successInput()),
    ).rejects.toMatchObject({ code: "JOB_STATE_CONFLICT" });
  });
});

describe("mapUniqueViolation", () => {
  function pgError(code: string, constraint: string) {
    return Object.assign(new Error("unique"), { code, constraint });
  }

  test("maps the dataset-version constraint", () => {
    const mapped = mapUniqueViolation(
      pgError("23505", "uq_model_versions_dataset_version"),
    );

    expect(mapped?.code).toBe("MODEL_VERSION_CONFLICT");
  });

  test("maps the training-job constraint", () => {
    const mapped = mapUniqueViolation(
      pgError("23505", "uq_model_versions_training_job_id"),
    );

    expect(mapped?.code).toBe("MODEL_VERSION_CONFLICT");
  });

  test("maps the content digest constraint", () => {
    const mapped = mapUniqueViolation(
      pgError("23505", "model_artifacts_content_sha256_unique"),
    );

    expect(mapped?.code).toBe("MODEL_ARTIFACT_CONTENT_CONFLICT");
  });

  test("ignores other violations and other errors", () => {
    expect(mapUniqueViolation(pgError("23505", "some_other_constraint"))).toBeNull();
    expect(mapUniqueViolation(pgError("23502", "not_null"))).toBeNull();
    expect(mapUniqueViolation(new Error("boom"))).toBeNull();
  });
});
