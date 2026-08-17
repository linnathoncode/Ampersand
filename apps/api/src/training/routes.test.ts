import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused";

const { trainingRoutes } = await import("./routes");

const url = "http://localhost/training-jobs";

const validBody = {
  datasetDefinitionId: "11111111-1111-4111-8111-111111111111",
};

function authorizedRequest(body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "22222222-2222-4222-8222-222222222222",
      "x-tenant-schema": "ampersand_dev",
      "x-auth-type": "jwt",
      "x-user-claims": "create.training_jobs",
    },
    body: JSON.stringify(body),
  });
}

describe("training job authorization", () => {
  test("rejects an unauthenticated request", async () => {
    const response = await trainingRoutes.handle(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
        issues: [],
      },
    });
  });

  test("rejects a user without the training claim", async () => {
    const response = await trainingRoutes.handle(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "22222222-2222-4222-8222-222222222222",
          "x-tenant-schema": "ampersand_dev",
          "x-auth-type": "jwt",
          "x-user-claims": "get.model_versions",
        },
        body: JSON.stringify(validBody),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Training job creation permission is required",
        issues: [],
      },
    });
  });
});

describe("training job body validation", () => {
  test("rejects a malformed request body before touching the database", async () => {
    const response = await trainingRoutes.handle(
      authorizedRequest({ datasetDefinitionId: "not-a-uuid" }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; issues: { path: string; message: string }[] };
    };
    expect(body.error.code).toBe("INVALID_TRAINING_REQUEST");
    expect(body.error.issues.length).toBeGreaterThan(0);
    expect(body.error.issues.some((issue) => issue.path.includes("datasetDefinitionId"))).toBe(true);
  });

  test("rejects unparseable JSON with a structured error", async () => {
    const response = await trainingRoutes.handle(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "22222222-2222-4222-8222-222222222222",
          "x-tenant-schema": "ampersand_dev",
          "x-auth-type": "jwt",
          "x-user-claims": "create.training_jobs",
        },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_TRAINING_REQUEST",
        message: "The training job request is invalid",
        issues: [
          {
            path: "$",
            message: "The request body could not be parsed as JSON",
          },
        ],
      },
    });
  });

  test("rejects client-supplied training settings", async () => {
    const response = await trainingRoutes.handle(
      authorizedRequest({
        datasetDefinitionId: "11111111-1111-4111-8111-111111111111",
        snapshotId: "22222222-2222-4222-8222-222222222222",
        trainingConfig: {
          trainerVersion: "9.9.9",
          algorithmPolicy: "automatic-regression",
          randomSeed: 1,
          splitStrategy: "chronological",
          testFraction: 0.5,
          maxRuntimeSeconds: 60,
        },
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; issues: { path: string }[] } };
    expect(body.error.code).toBe("INVALID_TRAINING_REQUEST");
    expect(body.error.issues.some((issue) => issue.path.includes("snapshotId"))).toBe(true);
    expect(body.error.issues.some((issue) => issue.path.includes("trainingConfig"))).toBe(true);
  });
});
