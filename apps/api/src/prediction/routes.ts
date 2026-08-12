import { PredictionRequestDto } from "@ampersand/contracts";
import { Elysia } from "elysia";
import type { PoolClient } from "pg";

import {
  getAuthContext,
  hasClaim,
  INVOKE_TOOL_CLAIM,
} from "../auth/context";
import { withTenantTransaction } from "../database/tenant-transaction";
import { completeToolPrediction } from "./complete-prediction";
import type { ModelInferenceResult } from "./create-response";
import { validateToolPrediction } from "./service";
import type { ValidateToolPredictionResult } from "./service";

type AcceptedPrediction = Extract<
  ValidateToolPredictionResult,
  { kind: "accepted" }
>;

type PredictionRouteDependencies = {
  validatePrediction: typeof validateToolPrediction;
  completePrediction: typeof completeToolPrediction;
  runInference?: (
    accepted: AcceptedPrediction,
  ) => Promise<ModelInferenceResult>;
  withTransaction: <Result>(
    schemaName: string,
    operation: (client: PoolClient) => Promise<Result>,
  ) => Promise<Result>;
};

const defaultDependencies: PredictionRouteDependencies = {
  validatePrediction: validateToolPrediction,
  completePrediction: completeToolPrediction,
  withTransaction: withTenantTransaction,
};

export function createPredictionRoutes(
  overrides: Partial<PredictionRouteDependencies> = {},
) {
  const dependencies: PredictionRouteDependencies = {
    ...defaultDependencies,
    ...overrides,
  };

  return new Elysia().post(
  "/predictions",
  async ({ body, request, set }) => {
    const auth = getAuthContext(request.headers);

    if (!auth) {
      set.status = 401;

      return {
        error: {
          code: "UNAUTHENTICATED",
          message: "Authentication is required",
        },
      };
    }

    if (!hasClaim(auth, INVOKE_TOOL_CLAIM)) {
      set.status = 403;

      return {
        error: {
          code: "FORBIDDEN",
          message: "Permission to call prediction tools is required",
        },
      };
    }

    const startedAt = performance.now();

    const result = await dependencies.withTransaction(
      auth.schemaName,
      (client) =>
        dependencies.validatePrediction(
        client,
        auth.schemaName,
        auth.userId,
        body,
      ),
    );

    if (result.kind === "error") {
      set.status = result.status;
      return result.body;
    }

    if (result.kind === "rejected") {
      return result.body;
    }

    if (!dependencies.runInference) {
      set.status = 501;

      return {
        error: {
          code: "INFERENCE_NOT_IMPLEMENTED",
          message: "Inputs are valid, but model inference is not implemented",
        },
      };
    }

    const inference = await dependencies.runInference(result);

    return dependencies.withTransaction(
      auth.schemaName,
      (client) =>
        dependencies.completePrediction(
          client,
          auth.schemaName,
          auth.userId,
          {
            accepted: result,
            request: body,
            inference,
            latencyMs: Math.max(
              0,
              Math.round(performance.now() - startedAt),
            ),
          },
        ),
    );
  },
  {
    body: PredictionRequestDto,
  },
  );
}

export const predictionRoutes = createPredictionRoutes();
