import { describe, expect, test } from "bun:test";
import type { PredictionRejectedResponse } from "@ampersand/contracts";
import type { PoolClient } from "pg";

import type { TenantQuotaStore } from "../quota/tenant-quota";

process.env.DATABASE_URL ??=
  "postgresql://unused:unused@localhost:5432/unused";

const { createPredictionRoutes, predictionRoutes } = await import("../routes");

const predictionUrl = "http://localhost/predictions";
const modelVersionId = "22222222-2222-4222-8222-222222222222";
const verifiedArtifactBytes = new TextEncoder().encode("verified model");
const onnxFeatures = [
  {
    name: "temperature",
    position: 0,
    dataType: "number" as const,
    isRequired: true,
    allowedValues: null,
  },
];

const validRequest = {
  toolName: "predict_energy_usage",
  inputs: {
    temperature: 22,
  },
};

const authorizedHeaders = {
  "content-type": "application/json",
  "x-user-id": "11111111-1111-4111-8111-111111111111",
  "x-tenant-schema": "tenant_ampersand_dev",
  "x-auth-type": "jwt",
  "x-user-claims": "invoke.tool_definitions",
};

const rejectedResponse: PredictionRejectedResponse = {
  outcome: "rejected",
  prediction: null,
  uncertainty: null,
  modelVersionId,
  modelVersion: 1,
  warnings: [],
  rejection: {
    code: "OUT_OF_RANGE",
    message: "One or more inputs are outside the supported range",
    fields: [
      {
        name: "temperature",
        message: "Must be between -20 and 50",
      },
    ],
  },
};

const runWithoutDatabase = async <Result>(
  _schemaName: string,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> => operation({} as PoolClient);

const quotaResetsAt = new Date("2026-08-19T00:00:00.000Z");
const unlimitedQuotaStore: TenantQuotaStore = {
  reserve: async () => ({
    allowed: true,
    used: 1,
    limit: 1_000,
    remaining: 999,
    resetsAt: quotaResetsAt,
  }),
  release: async () => {},
};
const unlimitedQuotaDependencies = {
  getQuotaStore: () => unlimitedQuotaStore,
  reserveQuota: async () => ({
    ok: true as const,
    reservation: {
      allowed: true as const,
      used: 1,
      limit: 1_000,
      remaining: 999,
      resetsAt: quotaResetsAt,
    },
  }),
};

describe("prediction route", () => {
  test("rejects an unauthenticated request", async () => {
    const response = await predictionRoutes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(validRequest),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      },
    });
  });

  test("rejects a user without invocation permission", async () => {
    const response = await predictionRoutes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: {
          ...authorizedHeaders,
          "x-user-claims": "publish.model_versions",
        },
        body: JSON.stringify(validRequest),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Permission to call prediction tools is required",
      },
    });
  });

  test("returns an authorized structured rejection", async () => {
    const routes = createPredictionRoutes({
      ...unlimitedQuotaDependencies,
      getQuotaStore: () => {
        throw new Error("Quota must not be reserved for rejected input");
      },
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => ({
        kind: "rejected",
        body: rejectedResponse,
      }),
    });

    const response = await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify(validRequest),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(rejectedResponse);
  });

  test("rejects a model without active input features", async () => {
    const routes = createPredictionRoutes({
      ...unlimitedQuotaDependencies,
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => ({
        kind: "accepted",
        toolDefinitionId: "33333333-3333-4333-8333-333333333333",
        modelVersionId,
        modelVersion: 1,
        inputs: validRequest.inputs,
        warnings: [],
      }),
      verifyArtifact: async () => ({
        ok: true,
        actualSha256: "0".repeat(64),
        bytes: verifiedArtifactBytes,
      }),
      listFeatures: async () => [],
    });

    const response = await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify(validRequest),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "MODEL_FEATURES_UNAVAILABLE",
        message: "The model does not define any active input features",
      },
    });
  });

  test("returns a completed prediction from an injected inference runner", async () => {
    const accepted = {
      kind: "accepted" as const,
      toolDefinitionId: "33333333-3333-4333-8333-333333333333",
      modelVersionId,
      modelVersion: 1,
      inputs: { temperature: 48 },
      warnings: [
        "temperature is close to the maximum accepted value of 50",
      ],
    };

    const completedResponse = {
      outcome: "prediction" as const,
      prediction: 124.6,
      uncertainty: 3.2,
      modelVersionId,
      modelVersion: 1,
      warnings: accepted.warnings,
      rejection: null,
    };

    const routes = createPredictionRoutes({
      ...unlimitedQuotaDependencies,
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => accepted,
      verifyArtifact: async () => ({
        ok: true,
        actualSha256: "0".repeat(64),
        bytes: verifiedArtifactBytes,
      }),
      listFeatures: async () => onnxFeatures,
      // Simulates future model execution without loading an ONNX artifact.
      runInference: async (input) => {
        expect(input.artifactBytes).toBe(verifiedArtifactBytes);
        expect(input.features).toEqual(onnxFeatures);
        expect(input.inputs).toEqual(accepted.inputs);

        return {
          prediction: 124.6,
          uncertainty: 3.2,
        };
      },
      completePrediction: async (_client, schemaName, createdBy, input) => {
        expect(schemaName).toBe("tenant_ampersand_dev");
        expect(createdBy).toBe(authorizedHeaders["x-user-id"]);
        expect(input.accepted).toEqual(accepted);
        expect(input.inference).toEqual({
          prediction: 124.6,
          uncertainty: 3.2,
        });
        expect(input.latencyMs).toBeGreaterThanOrEqual(0);

        return completedResponse;
      },
    });

    const response = await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify({
          ...validRequest,
          inputs: accepted.inputs,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Tenant-Quota-Limit")).toBe("1000");
    expect(response.headers.get("X-Tenant-Quota-Remaining")).toBe("999");
    expect(response.headers.get("X-Tenant-Quota-Reset")).toBe(
      quotaResetsAt.toISOString(),
    );
    expect(await response.json()).toEqual(completedResponse);
  });

  test("does not run inference when artifact verification fails", async () => {
    let inferenceAttempted = false;

    const routes = createPredictionRoutes({
      ...unlimitedQuotaDependencies,
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => ({
        kind: "accepted",
        toolDefinitionId: "33333333-3333-4333-8333-333333333333",
        modelVersionId,
        modelVersion: 1,
        inputs: validRequest.inputs,
        warnings: [],
      }),
      verifyArtifact: async () => ({
        ok: false,
        reason: "CHECKSUM_MISMATCH",
        message: "internal verification detail",
      }),
      runInference: async () => {
        inferenceAttempted = true;
        return { prediction: 1, uncertainty: null };
      },
    });

    const response = await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify(validRequest),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "MODEL_ARTIFACT_UNAVAILABLE",
        reason: "CHECKSUM_MISMATCH",
        message: "The verified model artifact is unavailable",
      },
    });
    expect(inferenceAttempted).toBe(false);
  });

  test("returns a safe error when ONNX inference fails", async () => {
    const routes = createPredictionRoutes({
      ...unlimitedQuotaDependencies,
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => ({
        kind: "accepted",
        toolDefinitionId: "33333333-3333-4333-8333-333333333333",
        modelVersionId,
        modelVersion: 1,
        inputs: validRequest.inputs,
        warnings: [],
      }),
      verifyArtifact: async () => ({
        ok: true,
        actualSha256: "0".repeat(64),
        bytes: verifiedArtifactBytes,
      }),
      listFeatures: async () => onnxFeatures,
      runInference: async () => {
        throw new Error("native runtime detail");
      },
    });

    const response = await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify(validRequest),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "MODEL_INFERENCE_FAILED",
        message: "The model could not produce a prediction",
      },
    });
  });

  test("returns 429 without verifying an artifact when quota is exhausted", async () => {
    let artifactVerificationAttempted = false;
    const routes = createPredictionRoutes({
      getQuotaStore: () => unlimitedQuotaStore,
      reserveQuota: async () => ({
        ok: false,
        status: 429,
        body: {
          error: {
            code: "TENANT_INFERENCE_QUOTA_EXCEEDED",
            message: "The tenant's daily inference quota has been reached",
            limit: 10,
            used: 10,
            resetsAt: quotaResetsAt.toISOString(),
          },
        },
      }),
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => ({
        kind: "accepted",
        toolDefinitionId: "33333333-3333-4333-8333-333333333333",
        modelVersionId,
        modelVersion: 1,
        inputs: validRequest.inputs,
        warnings: [],
      }),
      verifyArtifact: async () => {
        artifactVerificationAttempted = true;
        return {
          ok: true,
          actualSha256: "0".repeat(64),
          bytes: verifiedArtifactBytes,
        };
      },
    });

    const response = await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify(validRequest),
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("X-Tenant-Quota-Limit")).toBe("10");
    expect(response.headers.get("X-Tenant-Quota-Remaining")).toBe("0");
    expect(artifactVerificationAttempted).toBe(false);
  });

  test("fails closed when the quota service is unavailable", async () => {
    const routes = createPredictionRoutes({
      getQuotaStore: () => unlimitedQuotaStore,
      reserveQuota: async () => {
        throw new Error("Redis unavailable");
      },
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => ({
        kind: "accepted",
        toolDefinitionId: "33333333-3333-4333-8333-333333333333",
        modelVersionId,
        modelVersion: 1,
        inputs: validRequest.inputs,
        warnings: [],
      }),
    });

    const response = await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify(validRequest),
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "QUOTA_SERVICE_UNAVAILABLE",
        message: "The inference quota could not be verified",
      },
    });
  });

  test("releases quota when artifact verification fails before inference", async () => {
    let releases = 0;
    const store: TenantQuotaStore = {
      ...unlimitedQuotaStore,
      release: async (schemaName) => {
        expect(schemaName).toBe("tenant_ampersand_dev");
        releases += 1;
      },
    };
    const routes = createPredictionRoutes({
      ...unlimitedQuotaDependencies,
      getQuotaStore: () => store,
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => ({
        kind: "accepted",
        toolDefinitionId: "33333333-3333-4333-8333-333333333333",
        modelVersionId,
        modelVersion: 1,
        inputs: validRequest.inputs,
        warnings: [],
      }),
      verifyArtifact: async () => ({
        ok: false,
        reason: "CHECKSUM_MISMATCH",
        message: "internal verification detail",
      }),
    });

    await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify(validRequest),
      }),
    );

    expect(releases).toBe(1);
  });

  test("keeps quota consumed after inference starts", async () => {
    let releases = 0;
    const store: TenantQuotaStore = {
      ...unlimitedQuotaStore,
      release: async () => {
        releases += 1;
      },
    };
    const routes = createPredictionRoutes({
      ...unlimitedQuotaDependencies,
      getQuotaStore: () => store,
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => ({
        kind: "accepted",
        toolDefinitionId: "33333333-3333-4333-8333-333333333333",
        modelVersionId,
        modelVersion: 1,
        inputs: validRequest.inputs,
        warnings: [],
      }),
      verifyArtifact: async () => ({
        ok: true,
        actualSha256: "0".repeat(64),
        bytes: verifiedArtifactBytes,
      }),
      listFeatures: async () => onnxFeatures,
      runInference: async () => {
        throw new Error("Inference failed");
      },
    });

    await routes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify(validRequest),
      }),
    );

    expect(releases).toBe(0);
  });

  test("rejects a malformed request body", async () => {
    const response = await predictionRoutes.handle(
      new Request(predictionUrl, {
        method: "POST",
        headers: authorizedHeaders,
        body: JSON.stringify({
          toolName: "",
          inputs: {},
          unknownField: true,
        }),
      }),
    );

    expect(response.status).toBe(422);
  });
});
