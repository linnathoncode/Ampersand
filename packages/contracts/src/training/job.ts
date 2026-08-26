import { Type, type Static } from "@sinclair/typebox";

export const CreateTrainingJobDto = Type.Object(
  {
    datasetDefinitionId: Type.String({
      format: "uuid",
    }),
  },
  {
    additionalProperties: false,
  },
);

export type CreateTrainingJobInput = Static<typeof CreateTrainingJobDto>;

export const TrainingJobStatusDto = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("dead"),
]);

export type TrainingJobStatus = Static<typeof TrainingJobStatusDto>;

export const ResolvedTrainingConfigDto = Type.Object(
  {
    trainerVersion: Type.String(),
    algorithmPolicy: Type.Literal("automatic-regression"),
    randomSeed: Type.Integer(),
    splitStrategy: Type.Literal("chronological"),
    testFraction: Type.Number({
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
    }),
    maxRuntimeSeconds: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type ResolvedTrainingConfig = Static<typeof ResolvedTrainingConfigDto>;

export const TrainingJobErrorDto = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false },
);

export type TrainingJobError = Static<typeof TrainingJobErrorDto>;

export const TrainingJobRequestErrorCodeDto = Type.Union([
  Type.Literal("UNAUTHENTICATED"),
  Type.Literal("FORBIDDEN"),
  Type.Literal("INVALID_TRAINING_REQUEST"),
  Type.Literal("DATASET_DEFINITION_NOT_FOUND"),
  Type.Literal("DATASET_NOT_TRAINABLE"),
  Type.Literal("SNAPSHOT_NOT_FOUND"),
  Type.Literal("TRAINING_QUOTA_EXCEEDED"),
  Type.Literal("DUPLICATE_TRAINING_REQUEST"),
  Type.Literal("TRAINING_JOB_NOT_FOUND"),
  Type.Literal("JOB_TERMINAL_STATE"),
]);

export type TrainingJobRequestErrorCode = Static<
  typeof TrainingJobRequestErrorCodeDto
>;

export const TrainingJobRequestErrorDto = Type.Object(
  {
    error: Type.Object(
      {
        code: TrainingJobRequestErrorCodeDto,
        message: Type.String(),
        issues: Type.Array(
          Type.Object(
            {
              path: Type.String(),
              message: Type.String(),
            },
            {
              additionalProperties: false,
            },
          ),
        ),
      },
      {
        additionalProperties: false,
      },
    ),
  },
  {
    additionalProperties: false,
  },
);

export type TrainingJobRequestError = Static<
  typeof TrainingJobRequestErrorDto
>;

export const TrainingJobResponseDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    datasetSnapshotId: Type.String({ format: "uuid" }),
    fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    status: TrainingJobStatusDto,
    trainingConfig: ResolvedTrainingConfigDto,
    progressPercent: Type.Integer({ minimum: 0, maximum: 100 }),
    progressMessage: Type.Union([Type.String(), Type.Null()]),
    queuedAt: Type.String({ format: "date-time" }),
    startedAt: Type.Union([
      Type.String({ format: "date-time" }),
      Type.Null(),
    ]),
    heartbeatAt: Type.Union([
      Type.String({ format: "date-time" }),
      Type.Null(),
    ]),
    finishedAt: Type.Union([
      Type.String({ format: "date-time" }),
      Type.Null(),
    ]),
    error: Type.Union([TrainingJobErrorDto, Type.Null()]),
  },
  { additionalProperties: false },
);

export type TrainingJobResponse = Static<typeof TrainingJobResponseDto>;
