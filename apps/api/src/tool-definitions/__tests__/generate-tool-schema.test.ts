import { describe, expect, test } from "bun:test";

import {
  generateToolInputProperty,
  generateToolInputSchema,
  generateToolDefinition,
  predictionToolOutputSchema,
} from "../generate-tool-schema";

describe("tool input property generation", () => {
  test("converts a numerical model feature", () => {
    const property = generateToolInputProperty({
      columnName: "temperature",
      dataType: "number",
      description: "Outside temperature",
      unit: "celsius",
      isRequired: true,
      validMin: -20,
      validMax: 50,
      allowedValues: null,
    });

    expect(property).toEqual({
      type: "number",
      description: "Outside temperature (celsius)",
      minimum: -20,
      maximum: 50,
    });
  });

  test("converts a categorical model feature", () => {
    const property = generateToolInputProperty({
      columnName: "building_type",
      dataType: "category",
      description: "Type of building",
      unit: null,
      isRequired: true,
      validMin: null,
      validMax: null,
      allowedValues: ["residential", "commercial"],
    });

    expect(property).toEqual({
      type: "string",
      description: "Type of building",
      enum: ["residential", "commercial"],
    });
  });

  test("generates an input schema from model feature", () => {
    const schema = generateToolInputSchema([
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
      {
        columnName: "building_type",
        dataType: "category",
        description: "Type of building",
        unit: null,
        isRequired: false,
        validMin: null,
        validMax: null,
        allowedValues: ["residential", "commercial"],
      },
    ]);
    expect(schema).toEqual({
      type: "object",
      properties: {
        temperature: {
          type: "number",
          description: "Outside temperature (celsius)",
          minimum: -20,
          maximum: 50,
        },
        building_type: {
          type: "string",
          description: "Type of building",
          enum: ["residential", "commercial"],
        },
      },
      required: ["temperature"],
      additionalProperties: false,
    });
  });

  test("generates a complete prediction tool definition", () => {
    const definition = generateToolDefinition({
      modelVersionId: "d0ccd219-d34e-4096-a914-c9671d952bd0",
      toolName: "predict_energy_usage",
      description: "Predict building energy usage.",
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
    expect(definition.modelVersionId).toBe(
      "d0ccd219-d34e-4096-a914-c9671d952bd0",
    );
    expect(definition.toolName).toBe("predict_energy_usage");
    expect(definition.inputSchema.required).toEqual(["temperature"]);
    expect(definition.outputSchema).toEqual(predictionToolOutputSchema);
  });
});
