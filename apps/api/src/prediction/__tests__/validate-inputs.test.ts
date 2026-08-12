import { describe, expect, test } from "bun:test";

import type { ToolInputSchema } from "@ampersand/contracts";

import { validatePredictionInputs } from "../validate-inputs";

const inputSchema: ToolInputSchema = {
  type: "object",
  properties: {
    temperature: {
      type: "number",
      description: "Outside temperature",
      minimum: -20,
      maximum: 50,
    },
    occupancy: {
      type: "integer",
      description: "Number of occupants",
      minimum: 0,
    },
    buildingType: {
      type: "string",
      description: "Building type",
      enum: ["office", "residential"],
    },
    occupied: {
      type: "boolean",
      description: "Whether the building is occupied",
    },
  },
  required: ["temperature", "occupancy", "buildingType"],
  additionalProperties: false,
};

describe("prediction input validation", () => {
  test("accepts valid required and optional inputs", () => {
    const inputs = {
      temperature: 22.5,
      occupancy: 4,
      buildingType: "office",
      occupied: true,
    };

    expect(validatePredictionInputs(inputSchema, inputs)).toEqual({
      ok: true,
      inputs,
    });
  });

  test("rejects unknown inputs", () => {
    const result = validatePredictionInputs(inputSchema, {
      temperature: 22,
      occupancy: 4,
      buildingType: "office",
      humidity: 60,
    });

    expect(result).toEqual({
      ok: false,
      rejection: {
        code: "UNKNOWN_FEATURE",
        message: "The request contains unknown inputs",
        fields: [
          {
            name: "humidity",
            message: "This input is not accepted by the tool",
          },
        ],
      },
    });
  });

  test("rejects missing required inputs", () => {
    const result = validatePredictionInputs(inputSchema, {
      temperature: 22,
    });

    expect(result).toEqual({
      ok: false,
      rejection: {
        code: "MISSING_FEATURE",
        message: "One or more required inputs are missing",
        fields: [
          {
            name: "occupancy",
            message: "This input is required",
          },
          {
            name: "buildingType",
            message: "This input is required",
          },
        ],
      },
    });
  });

  test("rejects incorrect and non-finite numerical types", () => {
    const result = validatePredictionInputs(inputSchema, {
      temperature: Number.NaN,
      occupancy: 2.5,
      buildingType: "office",
    });

    expect(result).toEqual({
      ok: false,
      rejection: {
        code: "INVALID_TYPE",
        message: "One or more inputs have an invalid type",
        fields: [
          {
            name: "temperature",
            message: "Must be of type number",
          },
          {
            name: "occupancy",
            message: "Must be of type integer",
          },
        ],
      },
    });
  });

  test("rejects values outside the allowed category", () => {
    const result = validatePredictionInputs(inputSchema, {
      temperature: 22,
      occupancy: 4,
      buildingType: "warehouse",
    });

    expect(result).toEqual({
      ok: false,
      rejection: {
        code: "VALUE_NOT_ALLOWED",
        message: "One or more inputs contain unsupported values",
        fields: [
          {
            name: "buildingType",
            message: "Value is not included in the allowed values",
          },
        ],
      },
    });
  });

  test("rejects values outside numerical ranges", () => {
    const result = validatePredictionInputs(inputSchema, {
      temperature: 60,
      occupancy: -1,
      buildingType: "office",
    });

    expect(result).toEqual({
      ok: false,
      rejection: {
        code: "OUT_OF_RANGE",
        message: "One or more inputs are outside the supported range",
        fields: [
          {
            name: "temperature",
            message: "Must be between -20 and 50",
          },
          {
            name: "occupancy",
            message: "Must be at least 0",
          },
        ],
      },
    });
  });
});
