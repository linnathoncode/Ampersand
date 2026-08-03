import { Type, type Static } from "@sinclair/typebox";

export const PostgreSqlIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
});

export type PostgreSqlIdentifier = Static<
  typeof PostgreSqlIdentifierSchema
>;

export const DatasetColumnInputSchema = Type.Object(
  {
    name: PostgreSqlIdentifierSchema,
    description: Type.String({
      minLength: 1,
      maxLength: 500,
    }),
    unit: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 100,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
);

export type DatasetColumnInput = Static<typeof DatasetColumnInputSchema>;

export const CreateDatasetDefinitionDto = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      maxLength: 200,
    }),
    sourceTable: PostgreSqlIdentifierSchema,
    features: Type.Array(DatasetColumnInputSchema, {
      minItems: 1,
    }),
    target: DatasetColumnInputSchema,
    timeColumn: Type.Optional(DatasetColumnInputSchema),
  },
  {
    additionalProperties: false,
  },
);

export type CreateDatasetDefinitionInput = Static<
  typeof CreateDatasetDefinitionDto
>;

export const DatasetColumnRoleDto = Type.Union([
  Type.Literal("feature"),
  Type.Literal("target"),
  Type.Literal("time"),
  Type.Literal("ignored"),
]);

export type DatasetColumnRole = Static<typeof DatasetColumnRoleDto>;

export const DatasetColumnTypeDto = Type.Union([
  Type.Literal("number"),
  Type.Literal("integer"),
  Type.Literal("boolean"),
  Type.Literal("category"),
  Type.Literal("text"),
  Type.Literal("datetime"),
]);

export type DatasetColumnType = Static<typeof DatasetColumnTypeDto>;

export const DatasetColumnDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    role: DatasetColumnRoleDto,
    dataType: DatasetColumnTypeDto,
    description: Type.String(),
    unit: Type.Union([Type.String(), Type.Null()]),
    isNullable: Type.Boolean(),
    position: Type.Integer({ minimum: 0 }),
  },
  {
    additionalProperties: false,
  },
);

export type DatasetColumn = Static<typeof DatasetColumnDto>;

export const DatasetDefinitionResponseDto = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    name: Type.String(),
    sourceTable: Type.String(),
    targetColumn: Type.String(),
    timeColumn: Type.Union([Type.String(), Type.Null()]),
    columns: Type.Array(DatasetColumnDto),
    createdAt: Type.String({ format: "date-time" }),
  },
  {
    additionalProperties: false,
  },
);

export type DatasetDefinitionResponse = Static<
  typeof DatasetDefinitionResponseDto
>;
