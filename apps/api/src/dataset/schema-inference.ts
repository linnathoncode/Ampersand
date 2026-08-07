import type { DatasetColumnType } from "@ampersand/contracts";

export type SourceColumnInfo = {
  name: string;
  sqlType: string;
  isNullable: boolean;
  inferredType: DatasetColumnType | null;
};

const INTEGER_TYPES = new Set(["int2", "int4", "int8", "smallint", "integer", "bigint"]);
const NUMBER_TYPES = new Set([
  "numeric",
  "decimal",
  "float4",
  "float8",
  "real",
  "double precision",
]);
const BOOLEAN_TYPES = new Set(["bool", "boolean"]);
const DATETIME_TYPES = new Set(["date", "timestamp", "timestamptz"]);
const CATEGORY_TYPES = new Set(["varchar", "bpchar", "text"]);

export function inferColumnType(sqlType: string): DatasetColumnType | null {
  const normalized = sqlType.toLowerCase();
  if (INTEGER_TYPES.has(normalized)) return "integer";
  if (NUMBER_TYPES.has(normalized)) return "number";
  if (BOOLEAN_TYPES.has(normalized)) return "boolean";
  if (DATETIME_TYPES.has(normalized)) return "datetime";
  if (CATEGORY_TYPES.has(normalized)) return "category";

  return null;
}