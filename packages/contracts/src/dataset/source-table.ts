import { Type, type Static } from "@sinclair/typebox";

import { DatasetColumnTypeDto, PostgreSqlIdentifierSchema } from "./definition";

export const SourceTableColumnDto = Type.Object(
  {
    name: PostgreSqlIdentifierSchema,
    dataType: Type.Union([DatasetColumnTypeDto, Type.Null()]),
    isNullable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type SourceTableColumn = Static<typeof SourceTableColumnDto>;

export const SourceTableDto = Type.Object(
  {
    name: PostgreSqlIdentifierSchema,
    rowCount: Type.Integer({ minimum: 0 }),
    columns: Type.Array(SourceTableColumnDto),
  },
  { additionalProperties: false },
);

export type SourceTable = Static<typeof SourceTableDto>;

export const SourceTableListResponseDto = Type.Object(
  { tables: Type.Array(SourceTableDto) },
  { additionalProperties: false },
);

export type SourceTableListResponse = Static<typeof SourceTableListResponseDto>;

export const ImportedSourceTableResponseDto = Type.Object(
  { table: SourceTableDto },
  { additionalProperties: false },
);

export type ImportedSourceTableResponse = Static<
  typeof ImportedSourceTableResponseDto
>;
