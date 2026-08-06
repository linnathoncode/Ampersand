import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { uuid } from "../test-support";
import { GeneratedToolDefinitionDto } from "./index";

const outputSchema = {
  type: "object",
  properties: {
    outcome: { enum: ["prediction", "rejected"] },
    prediction: { type: ["number", "null"] },
    uncertainty: { type: ["number", "null"] },
    modelVersion: { type: "integer" },
    warnings: { type: "array", items: { type: "string" } },
    rejection: { type: ["object", "null"] },
  },
  required: [
    "outcome",
    "prediction",
    "uncertainty",
    "modelVersion",
    "warnings",
    "rejection",
  ],
  additionalProperties: false,
};

const definition = {
  modelVersionId: uuid,
  toolName: "predict_energy_usage",
  description: "Predict energy usage",
  generatorVersion: "1.0.0",
  inputSchema: {
    type: "object",
    properties: {
      temperature: {
        type: "number",
        description: "Temperature",
        minimum: -20,
        maximum: 50,
      },
    },
    required: ["temperature"],
    additionalProperties: false,
  },
  outputSchema,
};

describe("generated tool definition", () => {
  it("accepts a complete generated definition", () => {
    expect(Value.Check(GeneratedToolDefinitionDto, definition)).toBe(true);
  });

  it("rejects invalid model IDs, duplicate required fields, and extra properties", () => {
    expect(
      Value.Check(GeneratedToolDefinitionDto, {
        ...definition,
        modelVersionId: "not-a-uuid",
      }),
    ).toBe(false);
    expect(
      Value.Check(GeneratedToolDefinitionDto, {
        ...definition,
        inputSchema: {
          ...definition.inputSchema,
          required: ["temperature", "temperature"],
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(GeneratedToolDefinitionDto, { ...definition, draft: true }),
    ).toBe(false);
  });
});
