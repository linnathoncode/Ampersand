import { Type, type Static } from "@sinclair/typebox";

export const RetireModelVersionParamsDto = Type.Object(
  {
    modelVersionId: Type.String({ format: "uuid" }),
  },
  {
    additionalProperties: false,
  },
);

export type RetireModelVersionParams = Static<
  typeof RetireModelVersionParamsDto
>;

export const RetireModelVersionResponseDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    versionNumber: Type.Integer({ maximum: 1 }),
    status: Type.Literal("retired"),
    retiredAt: Type.String({ format: "date-time" }),
  },
  {
    additionalProperties: false,
  },
);

export type RetireModelVersionResponse = Static<
  typeof RetireModelVersionResponseDto
>;
