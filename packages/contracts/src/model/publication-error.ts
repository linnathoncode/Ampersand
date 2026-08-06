import { Type, type Static } from "@sinclair/typebox";

import { ModelVersionStatusDto } from "./version";

export const ModelPublicationErrorCodeDto = Type.Union([
  Type.Literal("MODEL_VERSION_NOT_FOUND"),
  Type.Literal("INVALID_MODEL_TRANSITION"),
]);

export type ModelPublicationErrorCode = Static<
  typeof ModelPublicationErrorCodeDto
>;

export const ModelPublicationErrorDto = Type.Object(
  {
    error: Type.Object(
      {
        code: ModelPublicationErrorCodeDto,
        message: Type.String({ minLength: 1 }),
        currentStatus: Type.Union([ModelVersionStatusDto, Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ModelPublicationError = Static<typeof ModelPublicationErrorDto>;
