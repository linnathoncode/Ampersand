import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";

process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused";

const { createInternalRoutes } = await import("../routes");

const definitionId = "33333333-3333-4333-8333-333333333333";
const jobId = "11111111-1111-4111-8111-111111111111";
const internalToken = "internal-secret";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeSuccessBody() {
  const storageRoot = await mkdtemp(join(tmpdir(), "ampersand-route-"));
  temporaryDirectories.push(storageRoot);
  const payload = Buffer.from("verified onnx bytes for route test");
  const tempName = `${jobId}.token.onnx.tmp`;

  await writeFile(join(storageRoot, tempName), payload);

  return {
    storageRoot,
    body: {
      workerId: "worker-a",
      fingerprint: "a".repeat(64),
      result: {
        status: "succeeded",
        metrics: { mae: 1.5, rmse: 2, r2: 0.8 },
        baselineMetrics: { mae: 5, rmse: 6, r2: 0 },
        artifact: {
          storageUri: tempName,
          format: "onnx" as const,
          contentSha256: createHash("sha256").update(payload).digest("hex"),
          sizeBytes: payload.byteLength,
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
    },
  };
}

function fakeClient(script: Record<string, unknown>): PoolClient {
  return {
    query: async (sql: string) => {
      for (const [fragment, response] of Object.entries(script)) {
        if (String(sql).includes(fragment)) {
          return response;
        }
      }

      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
}

function committedScript() {
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
    "FOR UPDATE OF dd": { rows: [{ id: definitionId }], rowCount: 1 },
    "COALESCE(MAX(version_number)": { rows: [{ version_number: 1 }], rowCount: 1 },
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
    "INSERT INTO model_versions": {
      rows: [{ id: "model-version-1", version_number: 1 }],
      rowCount: 1,
    },
    "UPDATE training_jobs": { rows: [], rowCount: 1 },
  };
}

const runWithoutDatabase = async <T>(
  script: Record<string, unknown>,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> => operation(fakeClient(script));

function makeRoutes(
  overrides: Parameters<typeof createInternalRoutes>[0] = {},
) {
  return createInternalRoutes({
    internalToken,
    submission: {
      runTransaction: (schemaName, operation) =>
        overrides.submission?.runTransaction
          ? overrides.submission.runTransaction(schemaName, operation)
          : runWithoutDatabase(committedScript(), operation),
    },
    ...overrides,
  });
}

const url = `http://localhost/internal/training-jobs/${jobId}/result`;

function minimalBody() {
  return {
    workerId: "worker-a",
    fingerprint: "a".repeat(64),
    result: { status: "succeeded" },
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${internalToken}`,
      "x-tenant-schema": "tenant_ampersand_dev",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("internal training result route", () => {
  function bearerHeaders(extra: Record<string, string> = {}) {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${internalToken}`,
      "x-tenant-schema": "tenant_ampersand_dev",
      ...extra,
    };
  }

  function post(body: unknown, headers: Record<string, string>, target = url) {
    return new Request(target, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  test("rejects a missing bearer token", async () => {
    const routes = makeRoutes();
    const headers = bearerHeaders();
    delete (headers as { authorization?: string }).authorization;

    const response = await routes.handle(post(minimalBody(), headers));

    expect(response.status).toBe(401);
  });

  test("rejects a wrong token", async () => {
    const response = await makeRoutes().handle(
      post(minimalBody(), bearerHeaders({ authorization: "Bearer nope" })),
    );

    expect(response.status).toBe(401);
  });

  test("rejects when no token is configured", async () => {
    const unconfigured = createInternalRoutes({ internalToken: undefined });

    const response = await unconfigured.handle(
      post(minimalBody(), bearerHeaders()),
    );

    expect(response.status).toBe(401);
  });

  test("rejects a malformed tenant schema header", async () => {
    const response = await makeRoutes().handle(
      post(
        minimalBody(),
        bearerHeaders({ "x-tenant-schema": "tenant_x; DROP SCHEMA x" }),
      ),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_TENANT_SCHEMA");
  });

  test("rejects a malformed job id", async () => {
    const response = await makeRoutes().handle(
      post(
        minimalBody(),
        bearerHeaders(),
        "http://localhost/internal/training-jobs/not-a-uuid/result",
      ),
    );

    expect(response.status).toBe(400);
  });

  test("rejects a body that fails the contract", async () => {
    const invalid = {
      workerId: "worker-a",
      fingerprint: "not-hex",
    };

    const response = await makeRoutes().handle(post(invalid, bearerHeaders()));

    expect(response.status).toBe(400);
    expect((await response.json()).error.issues.length).toBeGreaterThan(0);
  });

  test("registers a success result and returns the candidate", async () => {
    const { storageRoot, body } = await makeSuccessBody();

    const response = await makeRoutes({ storageRoot }).handle(
      post(body, bearerHeaders()),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "registered",
      modelVersionId: "model-version-1",
      versionNumber: 1,
      storageUri: `models/${definitionId}/v1/${jobId}.onnx`,
    });
  });

  test("surfaces ownership rejections as 409", async () => {
    const { storageRoot, body } = await makeSuccessBody();

    const routes = makeRoutes({
      storageRoot,
      submission: {
        runTransaction: async (_schemaName, operation) =>
          operation(
            fakeClient({
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
          ),
      },
    });

    const response = await routes.handle(post(body, bearerHeaders()));

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("JOB_OWNERSHIP");
  });

  test("responds unavailable when the registration transaction fails unexpectedly", async () => {
    const { storageRoot, body } = await makeSuccessBody();

    const routes = makeRoutes({
      storageRoot,
      submission: {
        runTransaction: async () => {
          throw new Error("connection terminated during commit");
        },
      },
    });

    const response = await routes.handle(post(body, bearerHeaders()));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("REGISTRATION_UNAVAILABLE");
  });
});
