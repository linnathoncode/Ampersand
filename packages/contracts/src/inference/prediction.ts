import { Type, type Static } from "@sinclair/typebox";

export const PredictionInputValueDto = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
]);

export type PredictionInputValue = Static<typeof PredictionInputValueDto>;

export const PredictionRequestDto = Type.Object(
  {
    toolName: Type.String({ minLength: 1 }),
    conversationId: Type.Optional(Type.String({ minLength: 1 })),
    inputs: Type.Record(Type.String(), PredictionInputValueDto),
  },
  { additionalProperties: false },
);

export type PredictionRequest = Static<typeof PredictionRequestDto>;

export const PredictionRejectionCodeDto = Type.Union([
  Type.Literal("OUT_OF_RANGE"),
  Type.Literal("INVALID_TYPE"),
  Type.Literal("MISSING_FEATURE"),
  Type.Literal("UNKNOWN_FEATURE"),
  Type.Literal("VALUE_NOT_ALLOWED"),
]);

export type PredictionRejectionCode = Static<
  typeof PredictionRejectionCodeDto
>;

export const PredictionRejectionFieldDto = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type PredictionRejectionField = Static<
  typeof PredictionRejectionFieldDto
>;

export const PredictionRejectionDto = Type.Object(
  {
    code: PredictionRejectionCodeDto,
    message: Type.String({ minLength: 1 }),
    fields: Type.Array(PredictionRejectionFieldDto, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type PredictionRejection = Static<typeof PredictionRejectionDto>;

export const PredictionSuccessResponseDto = Type.Object(
  {
    outcome: Type.Literal("prediction"),
    prediction: Type.Number(),
    uncertainty: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    modelVersionId: Type.String({ format: "uuid" }),
    modelVersion: Type.Integer({ minimum: 1 }),
    warnings: Type.Array(Type.String()),
    rejection: Type.Null(),
  },
  { additionalProperties: false },
);

export type PredictionSuccessResponse = Static<
  typeof PredictionSuccessResponseDto
>;

export const PredictionRejectedResponseDto = Type.Object(
  {
    outcome: Type.Literal("rejected"),
    prediction: Type.Null(),
    uncertainty: Type.Null(),
    modelVersionId: Type.String({ format: "uuid" }),
    modelVersion: Type.Integer({ minimum: 1 }),
    warnings: Type.Array(Type.String()),
    rejection: PredictionRejectionDto,
  },
  { additionalProperties: false },
);

export type PredictionRejectedResponse = Static<
  typeof PredictionRejectedResponseDto
>;

export const PredictionResponseDto = Type.Union([
  PredictionSuccessResponseDto,
  PredictionRejectedResponseDto,
]);

export type PredictionResponse = Static<typeof PredictionResponseDto>;
