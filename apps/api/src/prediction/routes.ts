import { PredictionRequestDto } from "@ampersand/contracts";
import { Elysia } from "elysia";
import type { PoolClient } from "pg";

import { getAuthContext, hasClaim, INVOKE_TOOL_CLAIM } from "../auth/context";
import { createFilesystemArtifactReader } from "../artifact-verification/filesystem-reader";
import { verifyStoredModelArtifact } from "../artifact-verification/service";
import { parseTrustedWorkerIds } from "../artifact-verification/trusted-workers";
import type { ArtifactVerificationResult } from "../artifact-verification/verify-artifact";
import { withTenantTransaction } from "../database/tenant-transaction";
import { completeToolPrediction } from "./complete-prediction";
import type { ModelInferenceResult } from "./create-response";
import { listOnnxFeatures } from "./onnx/repository";
import { runOnnxInference } from "./onnx/run-inference";
import { validateToolPrediction } from "./service";
import type { ValidateToolPredictionResult } from "./service";

import { reserveTenantInferenceQuota } from "./quota/service";
import { getTenantQuotaStore } from "./quota/store";

type AcceptedPrediction = Extract<
  ValidateToolPredictionResult,
  { kind: "accepted" }
>;

type PredictionRouteDependencies = {
  validatePrediction: typeof validateToolPrediction;
  verifyArtifact: (
    client: PoolClient,
    schemaName: string,
    modelVersionId: string,
  ) => Promise<ArtifactVerificationResult>;
  listFeatures: typeof listOnnxFeatures;
  completePrediction: typeof completeToolPrediction;
  runInference: typeof runOnnxInference;
  getQuotaStore: typeof getTenantQuotaStore;
  reserveQuota: typeof reserveTenantInferenceQuota;
  withTransaction: <Result>(
    schemaName: string,
    operation: (client: PoolClient) => Promise<Result>,
  ) => Promise<Result>;
};

const trustedWorkerIds = parseTrustedWorkerIds(process.env.TRUSTED_WORKER_IDS);
const readArtifact = createFilesystemArtifactReader(
  process.env.ARTIFACT_STORAGE_PATH ?? "./artifacts",
);

const defaultDependencies: PredictionRouteDependencies = {
  validatePrediction: validateToolPrediction,
  verifyArtifact: (client, schemaName, modelVersionId) =>
    verifyStoredModelArtifact(
      client,
      schemaName,
      modelVersionId,
      trustedWorkerIds,
      readArtifact,
    ),
  listFeatures: listOnnxFeatures,
  runInference: runOnnxInference,
  getQuotaStore: getTenantQuotaStore,
  reserveQuota: reserveTenantInferenceQuota,
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

      const quotaStore = dependencies.getQuotaStore();
      const quotaReservedAt = new Date();

      let quotaResult;

      try {
        quotaResult = await dependencies.reserveQuota(
          quotaStore,
          auth.schemaName,
          quotaReservedAt,
        );
      } catch {
        set.status = 503;

        return {
          error: {
            code: "QUOTA_SERVICE_UNAVAILABLE",
            message: "The inference quota could not be verified",
          },
        };
      }

      set.headers["X-Tenant-Quota-Limit"] = String(
        quotaResult.ok
          ? quotaResult.reservation.limit
          : quotaResult.body.error.limit,
      );
      set.headers["X-Tenant-Quota-Remaining"] = String(
        quotaResult.ok ? quotaResult.reservation.remaining : 0,
      );
      set.headers["X-Tenant-Quota-Reset"] = quotaResult.ok
        ? quotaResult.reservation.resetsAt.toISOString()
        : quotaResult.body.error.resetsAt;

      if (!quotaResult.ok) {
        set.status = quotaResult.status;
        return quotaResult.body;
      }

      let inferenceStarted = false;

      try {
        const artifactVerification = await dependencies.withTransaction(
          auth.schemaName,
          (client) =>
            dependencies.verifyArtifact(
              client,
              auth.schemaName,
              result.modelVersionId,
            ),
        );

        if (!artifactVerification.ok) {
          set.status = 503;

          return {
            error: {
              code: "MODEL_ARTIFACT_UNAVAILABLE",
              reason: artifactVerification.reason,
              message: "The verified model artifact is unavailable",
            },
          };
        }

        const features = await dependencies.withTransaction(
          auth.schemaName,
          (client) =>
            dependencies.listFeatures(
              client,
              auth.schemaName,
              result.modelVersionId,
            ),
        );

        if (features.length === 0) {
          set.status = 503;

          return {
            error: {
              code: "MODEL_FEATURES_UNAVAILABLE",
              message: "The model does not define any active input features",
            },
          };
        }

        let inference: ModelInferenceResult;

        inferenceStarted = true;

        try {
          inference = await dependencies.runInference({
            artifactBytes: artifactVerification.bytes,
            features,
            inputs: result.inputs,
          });
        } catch {
          set.status = 500;

          return {
            error: {
              code: "MODEL_INFERENCE_FAILED",
              message: "The model could not produce a prediction",
            },
          };
        }

        return dependencies.withTransaction(auth.schemaName, (client) =>
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
      } finally {
        if (!inferenceStarted) {
          try {
            await quotaStore.release(auth.schemaName, quotaReservedAt);
          } catch (error) {
            console.error("Failed to release tenant inference quota", error);
          }
        }
      }
    },
    {
      body: PredictionRequestDto,
    },
  );
}

export const predictionRoutes = createPredictionRoutes();
