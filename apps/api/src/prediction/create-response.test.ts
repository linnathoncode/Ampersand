import { describe, expect, test } from "bun:test";

import { createPredictionSuccessResponse } from "./create-response";

const modelVersionId = "22222222-2222-4222-8222-222222222222";

describe("prediction success response", () => {
  test("combines inference output with model metadata", () => {
    expect(
      createPredictionSuccessResponse({
        modelVersionId,
        modelVersion: 1,
        warnings: [],
        inference: {
          prediction: 124.6,
          uncertainty: 3.2,
        },
      }),
    ).toEqual({
      outcome: "prediction",
      prediction: 124.6,
      uncertainty: 3.2,
      modelVersionId,
      modelVersion: 1,
      warnings: [],
      rejection: null,
    });
  });

  test("includes boundary warnings in the response", () => {
    const warning =
      "temperature is close to the maximum accepted value of 50";

    const response = createPredictionSuccessResponse({
      modelVersionId,
      modelVersion: 1,
      warnings: [warning],
      inference: {
        prediction: 124.6,
        uncertainty: null,
      },
    });

    expect(response.warnings).toEqual([warning]);
    expect(response.uncertainty).toBeNull();
    expect(response.rejection).toBeNull();
  });
});
