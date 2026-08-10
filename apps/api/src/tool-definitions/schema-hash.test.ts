import { describe, expect, test } from "bun:test";

import { generateToolDefinition } from "./generate-tool-schema";
import { createToolDefinitionSha256 } from "./schema-hash";

const createDefinition = (modelVersionId: string) =>
  generateToolDefinition({
    modelVersionId,
    toolName: `predict_energy_${modelVersionId.slice(0, 8)}`,
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

describe("tool definition SHA-256", () => {
  test("returns the same hash for the same definition", () => {
    const definition = createDefinition("11111111-1111-4111-8111-111111111111");

    expect(createToolDefinitionSha256(definition)).toBe(
      createToolDefinitionSha256(definition),
    );
    expect(createToolDefinitionSha256(definition)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("returns a different hash for a different model version", () => {
    const first = createDefinition("11111111-1111-4111-8111-111111111111");
    const second = createDefinition("22222222-2222-4222-8222-222222222222");

    expect(createToolDefinitionSha256(first)).not.toBe(
      createToolDefinitionSha256(second),
    );
  });
});
