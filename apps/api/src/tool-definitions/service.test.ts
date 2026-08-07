import { describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";
import { generateModelToolDefinition } from "./service";

describe("model tool generation service", () => {
  test("generates a tool definition from a published model", async () => {
    const modelVersionId = "d0ccd219-d34e-4096-a914-c9671d952bd0";

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
});
