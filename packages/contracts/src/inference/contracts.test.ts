import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "bun:test";

import { uuid } from "../test-support";
import {
  PredictionRejectedResponseDto,
  PredictionRequestDto,
  PredictionResponseDto,
  PredictionSuccessResponseDto,
} from "./index";

const predictionBase = {
  modelVersionId: uuid,
  modelVersion: 1,
  warnings: [],
};

const success = {
  ...predictionBase,
  outcome: "prediction",
  prediction: 42.5,
  uncertainty: 0.2,
  rejection: null,
};

const rejected = {
  ...predictionBase,
  outcome: "rejected",
  prediction: null,
  uncertainty: null,
  rejection: {
    code: "OUT_OF_RANGE",
    message: "Temperature is outside the supported range",
    fields: [{ name: "temperature", message: "Must be at most 50" }],
  },
};

describe("prediction contracts", () => {
  it("accepts requests and both consistent response branches", () => {
    expect(
      Value.Check(PredictionRequestDto, {
        toolName: "predict_energy_usage",
        conversationId: "conversation-1",
        inputs: { temperature: 22, occupied: true },
      }),
    ).toBe(true);
    expect(Value.Check(PredictionSuccessResponseDto, success)).toBe(true);
    expect(Value.Check(PredictionRejectedResponseDto, rejected)).toBe(true);
    expect(Value.Check(PredictionResponseDto, success)).toBe(true);
    expect(Value.Check(PredictionResponseDto, rejected)).toBe(true);
  });

  it("rejects malformed requests and inconsistent response branches", () => {
    expect(
      Value.Check(PredictionRequestDto, {
        toolName: "predict_energy_usage",
        inputs: { nested: { value: 22 } },
      }),
    ).toBe(false);
    expect(
      Value.Check(PredictionRequestDto, {
        toolName: "predict_energy_usage",
        inputs: {},
        modelVersion: 1,
      }),
    ).toBe(false);
    expect(
      Value.Check(PredictionResponseDto, { ...success, outcome: "rejected" }),
    ).toBe(false);
    expect(
      Value.Check(PredictionResponseDto, { ...rejected, prediction: 42.5 }),
    ).toBe(false);
    expect(
      Value.Check(PredictionRejectedResponseDto, {
        ...rejected,
        rejection: { ...rejected.rejection, code: "UNKNOWN_CODE" },
      }),
    ).toBe(false);
    expect(
      Value.Check(PredictionSuccessResponseDto, {
        ...success,
        uncertainty: -0.1,
      }),
    ).toBe(false);
  });
});
