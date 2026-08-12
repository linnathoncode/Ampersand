import { Type, type Static } from "@sinclair/typebox";

export const DatasetDefinitionErrorCodeDto = Type.Union([
  Type.Literal("INVALID_DATASET_DEFINITION_REQUEST"),
  Type.Literal("SOURCE_TABLE_NOT_FOUND"),
  Type.Literal("SOURCE_TABLE_NOT_ALLOWED"),
  Type.Literal("COLUMN_NOT_FOUND"),
  Type.Literal("DUPLICATE_FEATURE"),
  Type.Literal("TARGET_IS_FEATURE"),
  Type.Literal("TIME_COLUMN_CONFLICT"),
  Type.Literal("UNSUPPORTED_COLUMN_TYPE"),
  Type.Literal("INVALID_TIME_COLUMN_TYPE"),
]);

export type DatasetDefinitionErrorCode = Static<
  typeof DatasetDefinitionErrorCodeDto
>;

export const ValidationIssueDto = Type.Object(
  {
    path: Type.String(),
    message: Type.String(),
  },
  {
    additionalProperties: false,
  },
);

export type ValidationIssue = Static<typeof ValidationIssueDto>;

export const DatasetDefinitionErrorDto = Type.Object(
  {
    error: Type.Object(
      {
        code: DatasetDefinitionErrorCodeDto,
        message: Type.String(),
        issues: Type.Array(ValidationIssueDto),
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

export type DatasetDefinitionError = Static<
  typeof DatasetDefinitionErrorDto
>;
