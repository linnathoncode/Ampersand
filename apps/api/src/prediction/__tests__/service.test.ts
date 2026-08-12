import { describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";

import { validateToolPrediction } from "../service";

const storedTool = {
  id: "11111111-1111-4111-8111-111111111111",
  modelVersionId: "22222222-2222-4222-8222-222222222222",
  modelVersion: 1,
  inputSchema: {
    type: "object" as const,
    properties: {
      temperature: {
        type: "number" as const,
        description: "Outside temperature",
        minimum: -20,
        maximum: 50,
      },
    },
    required: ["temperature"],
    additionalProperties: false as const,
  },
};

const request = {
  toolName: "predict_energy_usage",
  inputs: {
    temperature: 22,
  },
};
const createdBy = "33333333-3333-4333-8333-333333333333";

describe("prediction validation service", () => {
  test("prepares valid inputs for inference", async () => {
    const result = await validateToolPrediction(
      {} as PoolClient,
      "tenant_ampersand_dev",
      createdBy,
      request,
      {
        findTool: async () => storedTool,
        storeRejection: async () => {
          throw new Error("Valid inputs must not store a rejection");
        },
      },
    );

    expect(result).toEqual({
      kind: "accepted",
      toolDefinitionId: storedTool.id,
      modelVersionId: storedTool.modelVersionId,
      modelVersion: 1,
      inputs: {
        temperature: 22,
      },
      warnings: [],
    });
  });

  test("adds a warning for valid input near a model boundary", async () => {
    const result = await validateToolPrediction(
      {} as PoolClient,
      "tenant_ampersand_dev",
      createdBy,
      {
        ...request,
        inputs: { temperature: 48 },
      },
      {
        findTool: async () => storedTool,
        storeRejection: async () => {
          throw new Error("Valid inputs must not store a rejection");
        },
        boundaryWarningRatio: 0.1,
      },
    );

    expect(result).toMatchObject({
      kind: "accepted",
      warnings: [
        "temperature is close to the maximum accepted value of 50",
      ],
    });
  });

  test("returns a structured rejection for invalid inputs", async () => {
    const result = await validateToolPrediction(
      {} as PoolClient,
      "tenant_ampersand_dev",
      createdBy,
      {
        ...request,
        inputs: {
          temperature: 60,
        },
      },
      {
        findTool: async () => storedTool,
        storeRejection: async (_client, schemaName, input) => {
          expect(schemaName).toBe("tenant_ampersand_dev");
          expect(input).toMatchObject({
            toolDefinitionId: storedTool.id,
            modelVersionId: storedTool.modelVersionId,
            createdBy,
            conversationId: null,
            inputs: { temperature: 60 },
            rejection: { code: "OUT_OF_RANGE" },
          });
          expect(input.latencyMs).toBeGreaterThanOrEqual(0);

          return "44444444-4444-4444-8444-444444444444";
        },
      },
    );

    expect(result).toEqual({
      kind: "rejected",
      body: {
        outcome: "rejected",
        prediction: null,
        uncertainty: null,
        modelVersionId: storedTool.modelVersionId,
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
      },
    });
  });

  test("returns 404 when the tool is unavailable", async () => {
    const result = await validateToolPrediction(
      {} as PoolClient,
      "tenant_ampersand_dev",
      createdBy,
      request,
      {
        findTool: async () => null,
        storeRejection: async () => {
          throw new Error("Unavailable tools must not store a rejection");
        },
      },
    );

    expect(result).toEqual({
      kind: "error",
      status: 404,
      body: {
        error: {
          code: "TOOL_NOT_AVAILABLE",
          message: "The requested prediction tool is not available",
        },
      },
    });
  });

  test("returns 500 for a structurally invalid stored schema", async () => {
    const result = await validateToolPrediction(
      {} as PoolClient,
      "tenant_ampersand_dev",
      createdBy,
      request,
      {
        findTool: async () => ({
          ...storedTool,
          inputSchema: {
            type: "object",
            required: ["temperature"],
            additionalProperties: false,
          },
        }),
        storeRejection: async () => {
          throw new Error("Invalid schemas must not store a rejection");
        },
      },
    );

    expect(result).toEqual({
      kind: "error",
      status: 500,
      body: {
        error: {
          code: "INVALID_TOOL_SCHEMA",
          message: "The stored tool input schema is invalid",
        },
      },
    });
  });

  test("returns 500 when a required field has no property definition", async () => {
    const result = await validateToolPrediction(
      {} as PoolClient,
      "tenant_ampersand_dev",
      createdBy,
      request,
      {
        findTool: async () => ({
          ...storedTool,
          inputSchema: {
            ...storedTool.inputSchema,
            required: ["missingProperty"],
          },
        }),
        storeRejection: async () => {
          throw new Error("Invalid schemas must not store a rejection");
        },
      },
    );

    expect(result).toEqual({
      kind: "error",
      status: 500,
      body: {
        error: {
          code: "INVALID_TOOL_SCHEMA",
          message: "The stored tool input schema is invalid",
        },
      },
    });
  });
});
