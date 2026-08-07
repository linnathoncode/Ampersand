import type { DatasetColumnRole, DatasetColumnType } from "@ampersand/contracts";
import type { PoolClient } from "pg";

import { inferColumnType, type SourceColumnInfo } from "./schema-inference";

const MANAGED_TABLE_NAMES = new Set([
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
  schemaName: string,
  sourceTable: string,
): Promise<SourceTableLookup> {
  const table = await pool.query<{ table_type: string }>(
    `SELECT table_type
     FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = $2`,
    [schemaName, sourceTable],
  );

  if (!table.rows[0]) {
    return { kind: "not-found" };
  }

  if (
    table.rows[0].table_type !== "BASE TABLE" ||
    MANAGED_TABLE_NAMES.has(sourceTable)
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
    [schemaName, sourceTable],
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
      schemaName,
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
