import type {
  PredictionRequest,
  PredictionSuccessResponse,
} from "@ampersand/contracts";
import type { PoolClient } from "pg";

import type { ModelInferenceResult } from "./create-response";
import { createPredictionSuccessResponse } from "./create-response";
import { storeSuccessfulInferenceCall } from "./repository";
import type { ValidateToolPredictionResult } from "./service";

type AcceptedPrediction = Extract<
  ValidateToolPredictionResult,
  { kind: "accepted" }
>;

export type CompletePredictionInput = {
  accepted: AcceptedPrediction;
  request: PredictionRequest;
  inference: ModelInferenceResult;
  latencyMs: number;
};

type CompletePredictionDependencies = {
  storeSuccess: typeof storeSuccessfulInferenceCall;
};

const defaultDependencies: CompletePredictionDependencies = {
  storeSuccess: storeSuccessfulInferenceCall,
};

export async function completeToolPrediction(
  client: PoolClient,
  schemaName: string,
  createdBy: string,
  input: CompletePredictionInput,
  dependencies: CompletePredictionDependencies = defaultDependencies,
): Promise<PredictionSuccessResponse> {
  const response = createPredictionSuccessResponse({
    modelVersionId: input.accepted.modelVersionId,
    modelVersion: input.accepted.modelVersion,
    warnings: input.accepted.warnings,
    inference: input.inference,
  });

  await dependencies.storeSuccess(client, schemaName, {
    toolDefinitionId: input.accepted.toolDefinitionId,
    modelVersionId: input.accepted.modelVersionId,
    createdBy,
    conversationId: input.request.conversationId ?? null,
    inputs: input.accepted.inputs,
    prediction: response.prediction,
    uncertainty: response.uncertainty,
    warnings: response.warnings,
    latencyMs: input.latencyMs,
  });

  return response;
}
