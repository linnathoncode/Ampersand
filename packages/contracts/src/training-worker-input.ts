import { Type, type Static } from "@sinclair/typebox";

import { PostgreSqlIdentifierSchema } from "./dataset-definition";
import { ResolvedTrainingConfigDto } from "./training-job";

export const TrainingWorkerFeatureDataTypeDto = Type.Union([
  Type.Literal("number"),
  Type.Literal("integer"),
  Type.Literal("boolean"),
  Type.Literal("category"),
]);

export type TrainingWorkerFeatureDataType = Static<
  typeof TrainingWorkerFeatureDataTypeDto
>;

export const TrainingWorkerFeatureDto = Type.Object(
  {
    name: PostgreSqlIdentifierSchema,
    dataType: TrainingWorkerFeatureDataTypeDto,
    position: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type TrainingWorkerFeature = Static<typeof TrainingWorkerFeatureDto>;

export const TrainingWorkerTargetDto = Type.Object(
  {
    name: PostgreSqlIdentifierSchema,
    dataType: Type.Union([
      Type.Literal("number"),
      Type.Literal("integer"),
    ]),
  },
  { additionalProperties: false },
);

export type TrainingWorkerTarget = Static<typeof TrainingWorkerTargetDto>;

export const TrainingWorkerSnapshotDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    storageUri: Type.String({ minLength: 1 }),
    format: Type.Literal("parquet"),
    contentSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    rowCount: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type TrainingWorkerSnapshot = Static<
  typeof TrainingWorkerSnapshotDto
>;

export const TrainingWorkerInputDto = Type.Object(
  {
    tenantSchema: PostgreSqlIdentifierSchema,
    jobId: Type.String({ format: "uuid" }),
    jobFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    datasetDefinitionId: Type.String({ format: "uuid" }),
    snapshot: TrainingWorkerSnapshotDto,
    features: Type.Array(TrainingWorkerFeatureDto, { minItems: 1 }),
    target: TrainingWorkerTargetDto,
    timeColumn: Type.Union([PostgreSqlIdentifierSchema, Type.Null()]),
    trainingConfig: ResolvedTrainingConfigDto,
    artifactOutputDirectory: Type.String({ minLength: 1 }),
    heartbeatIntervalSeconds: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type TrainingWorkerInput = Static<typeof TrainingWorkerInputDto>;
