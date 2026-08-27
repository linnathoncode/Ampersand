import type {
  DatasetColumnRole,
  DatasetColumnType,
  SchemaSummary,
} from "@ampersand/contracts";
import type { PoolClient } from "pg";

import { inferColumnType, type SourceColumnInfo } from "./schema-inference";
import { tenantDataSchemaName } from "./tenant-data-schema";

export const MANAGED_TABLE_NAMES = new Set([
  "users",
  "profiles",
  "roles",
  "claims",
  "user_roles",
  "role_claims",
  "addresses",
  "phones",
  "tenants",
  "tenant_events",
  "tenant_features",
  "user_cohorts",
  "user_sessions",
  "trusted_devices",
  "password_reset_tokens",
  "magic_link_tokens",
  "webauthn_credentials",
  "webauthn_challenges",
  "oauth_accounts",
  "api_keys",
  "dataset_definitions",
  "dataset_columns",
  "dataset_snapshots",
  "training_jobs",
  "model_versions",
  "model_artifacts",
  "model_features",
  "tool_definitions",
  "inference_calls",
]);

export type SourceTableLookup =
  | { kind: "not-found" }
  | { kind: "not-allowed" }
  | { kind: "ok"; columns: SourceColumnInfo[] };

export async function inspectSourceTable(
  pool: PoolClient,
  sourceSchemaName: string,
  sourceTable: string,
): Promise<SourceTableLookup> {
  if (MANAGED_TABLE_NAMES.has(sourceTable)) {
    return { kind: "not-allowed" };
  }

  const table = await pool.query<{ table_type: string }>(
    `SELECT table_type
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [sourceSchemaName, sourceTable],
  );

  if (!table.rows[0]) {
    return { kind: "not-found" };
  }

  if (
    table.rows[0].table_type !== "BASE TABLE"
  ) {
    return { kind: "not-allowed" };
  }

  const columns = await pool.query<{
    column_name: string;
    udt_name: string;
    is_nullable: string;
  }>(
    `SELECT column_name, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [sourceSchemaName, sourceTable],
  );

  return {
    kind: "ok",
    columns: columns.rows.map((column) => ({
      name: column.column_name,
      sqlType: column.udt_name,
      isNullable: column.is_nullable === "YES",
      inferredType: inferColumnType(column.udt_name),
    })),
  };
}

export type InsertedDatasetDefinition = {
  id: string;
  createdAt: Date;
};

export type InsertedDatasetColumn = {
  id: string;
  columnName: string;
  role: DatasetColumnRole;
  dataType: DatasetColumnType;
  description: string;
  unit: string | null;
  isNullable: boolean;
  position: number;
};

export async function insertDatasetDefinition(
  pool: PoolClient,
  schemaName: string,
  input: {
    name: string;
    sourceTable: string;
    targetColumn: string;
    timeColumn: string | null;
    createdBy: string;
  },
): Promise<InsertedDatasetDefinition> {
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO dataset_definitions
       (name, source_schema, source_table, target_column, time_column, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [
      input.name,
      tenantDataSchemaName(schemaName),
      input.sourceTable,
      input.targetColumn,
      input.timeColumn,
      input.createdBy,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to create the dataset definition");
  }

  return { id: row.id, createdAt: row.created_at };
}

export async function insertDatasetColumn(
  pool: PoolClient,
  datasetDefinitionId: string,
  column: Omit<InsertedDatasetColumn, "id">,
): Promise<InsertedDatasetColumn> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO dataset_columns
       (dataset_definition_id, column_name, role, data_type, description, unit, is_nullable, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      datasetDefinitionId,
      column.columnName,
      column.role,
      column.dataType,
      column.description,
      column.unit,
      column.isNullable,
      column.position,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to create a dataset column");
  }

  return { ...column, id: row.id };
}

export type LoadedDatasetDefinition = {
  id: string;
  name: string;
  sourceSchema: string;
  sourceTable: string;
  createdBy: string | null;
};

export type LoadedDatasetColumn = {
  name: string;
  role: DatasetColumnRole;
  dataType: DatasetColumnType;
  isNullable: boolean;
  position: number;
};

export async function loadDatasetDefinition(
  pool: PoolClient,
  definitionId: string,
): Promise<LoadedDatasetDefinition | null> {
  const definition = await pool.query<{
    id: string;
    name: string;
    source_schema: string;
    source_table: string;
    created_by: string | null;
  }>(
    `SELECT id, name, source_schema, source_table, created_by
     FROM dataset_definitions
     WHERE id = $1 AND is_active = true`,
    [definitionId],
  );

  const row = definition.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    sourceSchema: row.source_schema,
    sourceTable: row.source_table,
    createdBy: row.created_by,
  };
}

export async function loadDatasetColumns(
  pool: PoolClient,
  definitionId: string,
): Promise<LoadedDatasetColumn[]> {
  const columns = await pool.query<{
    column_name: string;
    role: string;
    data_type: string;
    is_nullable: boolean;
    position: number;
  }>(
    `SELECT column_name, role, data_type, is_nullable, position
     FROM dataset_columns
     WHERE dataset_definition_id = $1
       AND role IN ('feature', 'target', 'time')
     ORDER BY position`,
    [definitionId],
  );

  return columns.rows.map((column) => ({
    name: column.column_name,
    role: column.role as DatasetColumnRole,
    dataType: column.data_type as DatasetColumnType,
    isNullable: column.is_nullable,
    position: column.position,
  }));
}

export type InsertedDatasetSnapshot = {
  id: string;
  frozenAt: Date;
};

export type LoadedDatasetSnapshot = InsertedDatasetSnapshot & {
  storageUri: string;
  contentSha256: string;
  rowCount: number;
  schemaSummary: SchemaSummary;
};

export async function loadDatasetSnapshotByContent(
  pool: PoolClient,
  datasetDefinitionId: string,
  contentSha256: string,
): Promise<LoadedDatasetSnapshot | null> {
  const result = await pool.query<{
    id: string;
    storage_uri: string;
    content_sha256: string;
    row_count: string;
    schema_summary: SchemaSummary;
    frozen_at: Date;
  }>(
    `SELECT id, storage_uri, content_sha256, row_count, schema_summary, frozen_at
     FROM dataset_snapshots
     WHERE dataset_definition_id = $1
       AND content_sha256 = $2
       AND is_active = true
     LIMIT 1`,
    [datasetDefinitionId, contentSha256],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    storageUri: row.storage_uri,
    contentSha256: row.content_sha256,
    rowCount: Number(row.row_count),
    schemaSummary: row.schema_summary,
    frozenAt: row.frozen_at,
  };
}

export async function insertDatasetSnapshot(
  pool: PoolClient,
  input: {
    datasetDefinitionId: string;
    storageUri: string;
    contentSha256: string;
    rowCount: number;
    schemaSummary: SchemaSummary;
  },
): Promise<InsertedDatasetSnapshot> {
  const result = await pool.query<{ id: string; frozen_at: Date }>(
    `INSERT INTO dataset_snapshots
       (dataset_definition_id, storage_uri, storage_format, content_sha256, row_count, schema_summary, frozen_at)
     VALUES ($1, $2, 'parquet', $3, $4, $5, now())
     RETURNING id, frozen_at`,
    [
      input.datasetDefinitionId,
      input.storageUri,
      input.contentSha256,
      input.rowCount,
      JSON.stringify(input.schemaSummary),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to create a dataset snapshot");
  }

  return { id: row.id, frozenAt: row.frozen_at };
}
