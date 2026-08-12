import { describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";
import { generateToolDefinition } from "../generate-tool-schema";
import {
  generateAndStoreModelToolDefinition,
  generateModelToolDefinition,
  getDiscoverableTools,
} from "../service";

const modelVersionId = "d0ccd219-d34e-4096-a914-c9671d952bd0";
const createdBy = "11111111-1111-4111-8111-111111111111";
const schemaSha256 = "a".repeat(64);

const generatedDefinition = generateToolDefinition({
  modelVersionId,
  toolName: "predict_energy_usage_d0ccd219",
  description: "Predict energy usage.",
  generatorVersion: "1.0.0",
  features: [
    {
      columnName: "temperature",
      dataType: "number",
      description: "Outside temperature",
      unit: "celsius",
      isRequired: true,
      validMin: -20,
      validMax: 50,
      allowedValues: null,
    },
  ],
});

const storedDefinition = {
  id: "22222222-2222-4222-8222-222222222222",
  ...generatedDefinition,
  schemaSha256,
  generatedAt: new Date("2026-08-10T09:00:00.000Z"),
};

describe("model tool generation service", () => {
  test("generates a tool definition from a published model", async () => {
    const result = await generateModelToolDefinition(
      {} as PoolClient,
      "tenant_ampersand_dev",
      modelVersionId,
      {
        findModel: async () => ({
          id: modelVersionId,
          status: "published",
          versionNumber: 1,
          datasetName: "Energy predictor",
          targetColumn: "energy_usage",
          artifactId: "4d3cf9ab-e7d3-49a9-b4f7-d4c1a23618ed",
        }),
        listFeatures: async () => [
          {
            columnName: "temperature",
            position: 0,
            dataType: "number",
            description: "Outside temperature",
            unit: "celsius",
            isRequired: true,
            validMin: "-20",
            validMax: "50",
            allowedValues: null,
          },
        ],
      },
    );

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("Expected tool generation to succeed");
    }

    expect(result.body.toolName).toBe("predict_energy_usage_d0ccd219");
    expect(result.body.description).toBe(
      "Predict energy_usage using Energy predictor model version 1.",
    );
    expect(result.body.inputSchema.properties.temperature).toEqual({
      type: "number",
      description: "Outside temperature (celsius)",
      minimum: -20,
      maximum: 50,
    });
    expect(result.body.inputSchema.required).toEqual(["temperature"]);
  });

  test("generates, hashes, and stores a new tool definition", async () => {
    const result = await generateAndStoreModelToolDefinition(
      {} as PoolClient,
      "tenant_ampersand_dev",
      modelVersionId,
      createdBy,
      {
        findExisting: async () => null,
        generateDefinition: async () => ({
          ok: true,
          body: generatedDefinition,
        }),
        createHash: (definition) => {
          expect(definition).toEqual(generatedDefinition);
          return schemaSha256;
        },
        storeDefinition: async (
          _client,
          schemaName,
          definition,
          hash,
          userId,
        ) => {
          expect(schemaName).toBe("tenant_ampersand_dev");
          expect(definition).toEqual(generatedDefinition);
          expect(hash).toBe(schemaSha256);
          expect(userId).toBe(createdBy);
          return storedDefinition;
        },
      },
    );

    expect(result).toEqual({ ok: true, body: storedDefinition });
  });

  test("rejects a model version that already has a tool definition", async () => {
    const result = await generateAndStoreModelToolDefinition(
      {} as PoolClient,
      "tenant_ampersand_dev",
      modelVersionId,
      createdBy,
      {
        findExisting: async () => storedDefinition,
        generateDefinition: async () => {
          throw new Error("Generation should not run for a duplicate");
        },
        createHash: () => {
          throw new Error("Hashing should not run for a duplicate");
        },
        storeDefinition: async () => {
          throw new Error("Storage should not run for a duplicate");
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        error: {
          code: "TOOL_DEFINITION_ALREADY_EXISTS",
          message: "This model version already has a tool definition",
        },
      },
    });
  });

  test("returns a generation error without hashing or storing", async () => {
    const result = await generateAndStoreModelToolDefinition(
      {} as PoolClient,
      "tenant_ampersand_dev",
      modelVersionId,
      createdBy,
      {
        findExisting: async () => null,
        generateDefinition: async () => ({
          ok: false,
          status: 404,
          body: {
            error: {
              code: "MODEL_VERSION_NOT_FOUND",
              message: "Model version was not found",
            },
          },
        }),
        createHash: () => {
          throw new Error("Hashing should not run after a generation error");
        },
        storeDefinition: async () => {
          throw new Error("Storage should not run after a generation error");
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: {
        error: {
          code: "MODEL_VERSION_NOT_FOUND",
          message: "Model version was not found",
        },
      },
    });
  });

  test("returns only the LLM-facing fields of published tools", async () => {
    const result = await getDiscoverableTools(
      {} as PoolClient,
      "tenant_ampersand_dev",
      {
        listPublished: async () => [storedDefinition],
      },
    );

    expect(result).toEqual([generatedDefinition]);
    expect(result[0]).not.toHaveProperty("id");
    expect(result[0]).not.toHaveProperty("schemaSha256");
    expect(result[0]).not.toHaveProperty("generatedAt");
  });
});
