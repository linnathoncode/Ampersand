import { describe, expect, test } from "bun:test";
import type { PredictionRejectedResponse } from "@ampersand/contracts";
import type { PoolClient } from "pg";

process.env.DATABASE_URL ??=
  "postgresql://unused:unused@localhost:5432/unused";

const { createPredictionRoutes, predictionRoutes } = await import("./routes");

const predictionUrl = "http://localhost/predictions";
const modelVersionId = "22222222-2222-4222-8222-222222222222";

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

  test("hands authorized valid input to the future inference stage", async () => {
    const routes = createPredictionRoutes({
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

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: {
        code: "INFERENCE_NOT_IMPLEMENTED",
        message: "Inputs are valid, but model inference is not implemented",
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
      withTransaction: runWithoutDatabase,
      validatePrediction: async () => accepted,
      // Simulates future model execution without loading an ONNX artifact.
      runInference: async () => ({
        prediction: 124.6,
        uncertainty: 3.2,
      }),
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
    expect(await response.json()).toEqual(completedResponse);
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
