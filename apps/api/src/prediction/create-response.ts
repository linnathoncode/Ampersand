import type { PredictionSuccessResponse } from "@ampersand/contracts";

export type ModelInferenceResult = {
  prediction: number;
  uncertainty: number | null;
};

export type CreatePredictionResponseInput = {
  modelVersionId: string;
  modelVersion: number;
  warnings: string[];
  inference: ModelInferenceResult;
};

export function createPredictionSuccessResponse(
  input: CreatePredictionResponseInput,
): PredictionSuccessResponse {
  return {
    outcome: "prediction",
    prediction: input.inference.prediction,
    uncertainty: input.inference.uncertainty,
    modelVersionId: input.modelVersionId,
    modelVersion: input.modelVersion,
    warnings: input.warnings,
    rejection: null,
  };
}
