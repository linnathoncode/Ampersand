import { Type, type Static } from "@sinclair/typebox";

import { ModelVersionStatusDto } from "./version";

export const ModelRetirementErrorCodeDto = Type.Union([
  Type.Literal("MODEL_VERSION_NOT_FOUND"),
  Type.Literal("INVALID_MODEL_TRANSITION"),
]);

export type ModelRetirementsErrorCode = Static<
  typeof ModelRetirementErrorCodeDto
>;

export const ModelRetirementErrorDto = Type.Object(
  {
    error: Type.Object(
      {
        code: ModelRetirementErrorCodeDto,
        message: Type.String({ minLength: 1 }),
        currentStatus: Type.Union([ModelVersionStatusDto, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ModelRetirementError = Static<typeof ModelRetirementErrorDto>;
