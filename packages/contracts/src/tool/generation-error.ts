import { Type, type Static } from "@sinclair/typebox";

export const ToolGenerationErrorCodeDto = Type.Union([
  Type.Literal("MODEL_VERSION_NOT_FOUND"),
  Type.Literal("MODEL_VERSION_NOT_PUBLISHED"),
  Type.Literal("MODEL_ARTIFACT_NOT_FOUND"),
  Type.Literal("MODEL_FEATURES_NOT_FOUND"),
  Type.Literal("INVALID_MODEL_FEATURE_METADATA"),
  Type.Literal("TOOL_DEFINITION_ALREADY_EXISTS"),
]);

export type ToolGenerationErrorCode = Static<typeof ToolGenerationErrorCodeDto>;

export const ToolGenerationErrorDto = Type.Object(
  {
    error: Type.Object(
      {
        code: ToolGenerationErrorCodeDto,
        message: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ToolGenerationError = Static<typeof ToolGenerationErrorDto>;
