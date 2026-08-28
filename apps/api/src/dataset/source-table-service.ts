import type { DatasetColumnType, SourceTable } from "@ampersand/contracts";
import { parse } from "csv-parse/sync";
import type { PoolClient } from "pg";

import { inferColumnType } from "./schema-inference";
import { MANAGED_TABLE_NAMES } from "./repository";
import { ensureTenantDataSchema, tenantDataSchemaName } from "./tenant-data-schema";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_IMPORT_ROWS = 100_000;
const INSERT_BATCH_SIZE = 500;

type CsvValue = string | null;

export type ImportSourceTableResult =
  | { ok: true; table: SourceTable }
  | {
      ok: false;
      status: 400 | 409 | 413 | 422;
      code: string;
      message: string;
    };

export async function listSourceTables(
  client: PoolClient,
  schemaName: string,
): Promise<SourceTable[]> {
  const dataSchemaName = tenantDataSchemaName(schemaName);
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [dataSchemaName],
  );

  const sourceNames = tables.rows
    .map((row) => row.table_name)
    .filter((name) => !MANAGED_TABLE_NAMES.has(name));

  const sourceTables: SourceTable[] = [];
  for (const name of sourceNames) {
    sourceTables.push(await describeSourceTable(client, dataSchemaName, name));
  }

  return sourceTables;
}

export async function importCsvSourceTable(
  client: PoolClient,
  schemaName: string,
  tableName: string,
  csvText: string,
): Promise<ImportSourceTableResult> {
  if (!IDENTIFIER.test(tableName) || MANAGED_TABLE_NAMES.has(tableName)) {
    return importError(400, "INVALID_TABLE_NAME", "Use a valid, non-reserved table name");
  }

  let records: Record<string, string>[];
  try {
    records = parse(csvText, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch {
    return importError(422, "INVALID_CSV", "The CSV file could not be parsed");
  }

  if (records.length === 0) {
    return importError(422, "EMPTY_CSV", "The CSV file contains no data rows");
  }
  if (records.length > MAX_IMPORT_ROWS) {
    return importError(413, "CSV_ROW_LIMIT_EXCEEDED", `CSV imports are limited to ${MAX_IMPORT_ROWS} rows`);
  }

  const headers = Object.keys(records[0] ?? {});
  if (headers.length === 0 || headers.some((header) => !IDENTIFIER.test(header))) {
    return importError(422, "INVALID_CSV_HEADERS", "Every CSV header must be a valid PostgreSQL identifier");
  }

  const dataSchemaName = await ensureTenantDataSchema(client, schemaName);

  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [dataSchemaName, tableName],
  );
  if ((exists.rowCount ?? 0) > 0) {
    return importError(409, "SOURCE_TABLE_EXISTS", `A table named '${tableName}' already exists`);
  }

  const columns = headers.map((name) => {
    const values = records.map((record) => normalizeCsvValue(record[name]));
    return {
      name,
      dataType: inferCsvColumnType(values),
      isNullable: values.some((value) => value === null),
    };
  });

  const definitions = columns
    .map((column) => `${quoteIdentifier(column.name)} ${toPostgresType(column.dataType)}`)
    .join(", ");
  await client.query(
    `CREATE TABLE ${quoteIdentifier(dataSchemaName)}.${quoteIdentifier(tableName)} (${definitions})`,
  );

  for (let offset = 0; offset < records.length; offset += INSERT_BATCH_SIZE) {
    const batch = records.slice(offset, offset + INSERT_BATCH_SIZE);
    await insertCsvBatch(client, dataSchemaName, tableName, columns, batch);
  }

  return {
    ok: true,
    table: { name: tableName, rowCount: records.length, columns },
  };
}

async function describeSourceTable(
  client: PoolClient,
  schemaName: string,
  tableName: string,
): Promise<SourceTable> {
  const columnResult = await client.query<{
    column_name: string;
    udt_name: string;
    is_nullable: string;
  }>(
    `SELECT column_name, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schemaName, tableName],
  );
  const countResult = await client.query<{ row_count: string }>(
    `SELECT count(*)::text AS row_count FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`,
  );

  return {
    name: tableName,
    rowCount: Number(countResult.rows[0]?.row_count ?? 0),
    columns: columnResult.rows.map((column) => ({
      name: column.column_name,
      dataType: inferColumnType(column.udt_name),
      isNullable: column.is_nullable === "YES",
    })),
  };
}

async function insertCsvBatch(
  client: PoolClient,
  schemaName: string,
  tableName: string,
  columns: SourceTable["columns"],
  records: Record<string, string>[],
): Promise<void> {
  const values: CsvValue[] = [];
  const rows = records.map((record, rowIndex) => {
    const placeholders = columns.map((column, columnIndex) => {
      values.push(normalizeCsvValue(record[column.name]));
      return `$${rowIndex * columns.length + columnIndex + 1}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const names = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  await client.query(
    `INSERT INTO ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} (${names}) VALUES ${rows.join(", ")}`,
    values,
  );
}

function inferCsvColumnType(values: CsvValue[]): DatasetColumnType {
  const present = values.filter((value): value is string => value !== null);
  if (present.length > 0 && present.every((value) => /^[-+]?\d+$/.test(value))) return "integer";
  if (present.length > 0 && present.every((value) => Number.isFinite(Number(value)))) return "number";
  if (present.length > 0 && present.every((value) => /^(true|false)$/i.test(value))) return "boolean";
  if (present.length > 0 && present.every((value) => ISO_DATE_TIME.test(value))) return "datetime";
  return "text";
}

function toPostgresType(type: DatasetColumnType): string {
  switch (type) {
    case "integer": return "bigint";
    case "number": return "double precision";
    case "boolean": return "boolean";
    case "datetime": return "timestamptz";
    default: return "text";
  }
}

function normalizeCsvValue(value: string | undefined): CsvValue {
  return value === undefined || value === "" ? null : value;
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function importError(
  status: 400 | 409 | 413 | 422,
  code: string,
  message: string,
): ImportSourceTableResult {
  return { ok: false, status, code, message };
}
