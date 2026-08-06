import { Type, type Static } from "@sinclair/typebox";

import { PostgreSqlIdentifierSchema } from "../dataset/definition";
import { TrainingWorkerFeatureDataTypeDto } from "./worker-input";

export const TrainingWorkerMetricsDto = Type.Object(
  {
    mae: Type.Number({ minimum: 0 }),
    rmse: Type.Number({ minimum: 0 }),
    r2: Type.Number(),
  },
  { additionalProperties: false },
);

export type TrainingWorkerMetrics = Static<typeof TrainingWorkerMetricsDto>;

export const TrainingWorkerArtifactDto = Type.Object(
  {
    storageUri: Type.String({ minLength: 1 }),
    format: Type.Literal("onnx"),
    contentSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    sizeBytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type TrainingWorkerArtifact = Static<typeof TrainingWorkerArtifactDto>;

export const TrainingWorkerModelFeatureDto = Type.Object(
  {
    name: PostgreSqlIdentifierSchema,
    position: Type.Integer({ minimum: 0 }),
    dataType: TrainingWorkerFeatureDataTypeDto,
    validMin: Type.Union([Type.Number(), Type.Null()]),
    validMax: Type.Union([Type.Number(), Type.Null()]),
    allowedValues: Type.Union([
      Type.Array(Type.Union([Type.String(), Type.Number()])),
      Type.Null(),
    ]),
    missingRate: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export type TrainingWorkerModelFeature = Static<
  typeof TrainingWorkerModelFeatureDto
>;

export const TrainingWorkerSuccessDto = Type.Object(
  {
    status: Type.Literal("succeeded"),
    metrics: TrainingWorkerMetricsDto,
    baselineMetrics: TrainingWorkerMetricsDto,
    artifact: TrainingWorkerArtifactDto,
    features: Type.Array(TrainingWorkerModelFeatureDto, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type TrainingWorkerSuccess = Static<typeof TrainingWorkerSuccessDto>;

export const TrainingWorkerFailureDto = Type.Object(
  {
    status: Type.Literal("failed"),
    error: Type.Object(
      {
        code: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type TrainingWorkerFailure = Static<typeof TrainingWorkerFailureDto>;

export const TrainingWorkerResultDto = Type.Object(
  {
    jobId: Type.String({ format: "uuid" }),
    jobFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    workerId: Type.String({ minLength: 1 }),
    result: Type.Union([
      TrainingWorkerSuccessDto,
      TrainingWorkerFailureDto,
    ]),
  },
  { additionalProperties: false },
);

export type TrainingWorkerResult = Static<typeof TrainingWorkerResultDto>;
