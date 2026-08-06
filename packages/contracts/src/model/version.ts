import { Type, type Static } from "@sinclair/typebox";

export const ModelVersionStatusDto = Type.Union([
  Type.Literal("candidate"),
  Type.Literal("published"),
  Type.Literal("retired"),
]);

export type ModelVersionStatus = Static<typeof ModelVersionStatusDto>;

export const PublishModelVersionParamsDto = Type.Object(
  {
    modelVersionId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export type PublishModelVersionParams = Static<
  typeof PublishModelVersionParamsDto
>;

export const PublishModelVersionResponseDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    versionNumber: Type.Integer({ minimum: 1 }),
    status: Type.Literal("published"),
    publishedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type PublishModelVersionResponse = Static<
  typeof PublishModelVersionResponseDto
>;

export const ModelVersionSummaryDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    datasetDefinitionId: Type.String({ format: "uuid" }),
    trainingJobId: Type.String({ format: "uuid" }),
    versionNumber: Type.Integer({ minimum: 1 }),
    status: ModelVersionStatusDto,
    parentVersionId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    publishedBy: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    publishedAt: Type.Union([
      Type.String({ format: "date-time" }),
      Type.Null(),
    ]),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type ModelVersionSummary = Static<typeof ModelVersionSummaryDto>;

export const ModelRegistryResponseDto = Type.Object(
  {
    models: Type.Array(ModelVersionSummaryDto),
  },
  { additionalProperties: false },
);

export type ModelRegistryResponse = Static<typeof ModelRegistryResponseDto>;
