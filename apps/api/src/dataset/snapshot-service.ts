import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import type {
  DatasetSnapshotError,
  DatasetSnapshotRecord,
  SchemaSummary,
} from "@ampersand/contracts";
import type { PoolClient } from "pg";

import {
  resolveCursorBatchSize,
  resolveCursorTimeoutMs,
  resolveSnapshotRowLimit,
} from "./config";
import {
  TenantStorageQuotaExceededError,
  enforceTenantStorageQuota,
} from "../cleanup/quota";
import {
  isFloat64LosslessDecimal,
  NumericPrecisionLossError,
} from "./numeric-precision";
import {
  insertDatasetSnapshot,
  inspectSourceTable,
  loadDatasetSnapshotByContent,
  loadDatasetColumns,
  loadDatasetDefinition,
} from "./repository";
import type { LoadedDatasetColumn } from "./repository";
import type {
  SnapshotStorage,
  SnapshotStorageColumn,
  SnapshotStorageRow,
  WrittenSnapshot,
} from "./storage";
import { tenantDataSchemaName } from "./tenant-data-schema";

const POSTGRESQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMEZONE_LESS_TYPES = new Set(["date", "timestamp"]);
const PRECISE_NUMERIC_TYPES = new Set(["numeric", "decimal"]);

export type CreateDatasetSnapshotResult =
  | { ok: true; body: DatasetSnapshotRecord }
  | { ok: false; status: number; body: DatasetSnapshotError };

export async function createDatasetSnapshot(
  pool: PoolClient,
  schemaName: string,
  definitionId: string,
  storage: SnapshotStorage,
): Promise<CreateDatasetSnapshotResult> {
  const definition = await loadDatasetDefinition(pool, definitionId);
  if (!definition) {
    return snapshotError(404, "DATASET_DEFINITION_NOT_FOUND", {
      path: "datasetDefinitionId",
      message: `No dataset definition with id '${definitionId}' exists`,
    });
  }

  if (definition.sourceSchema !== tenantDataSchemaName(schemaName)) {
    return snapshotError(422, "DATASET_SOURCE_TABLE_NOT_ALLOWED", {
      path: "sourceTable",
      message: `Source table '${definition.sourceTable}' is outside the tenant data schema`,
    });
  }

  const sourceLookup = await inspectSourceTable(
    pool,
    definition.sourceSchema,
    definition.sourceTable,
  );
  if (sourceLookup.kind === "not-found") {
    return snapshotError(422, "DATASET_SOURCE_TABLE_MISSING", {
      path: "sourceTable",
      message: `Source table '${definition.sourceTable}' is no longer available`,
    });
  }

  if (sourceLookup.kind === "not-allowed") {
    return snapshotError(422, "DATASET_SOURCE_TABLE_NOT_ALLOWED", {
      path: "sourceTable",
      message: `Source table '${definition.sourceTable}' cannot be used for snapshots`,
    });
  }

  const columns = await loadDatasetColumns(pool, definitionId);
  if (columns.length === 0) {
    return snapshotError(422, "DATASET_DEFINITION_HAS_NO_COLUMNS", {
      path: "columns",
      message: `Dataset definition '${definitionId}' has no selected columns`,
    });
  }

  const sourceColumnNames = new Set(
    sourceLookup.columns.map((column) => column.name),
  );
  const sourceSqlTypeByName = new Map(
    sourceLookup.columns.map((column) => [column.name, column.sqlType]),
  );
  for (const column of columns) {
    if (!POSTGRESQL_IDENTIFIER.test(column.name)) {
      return snapshotError(422, "DATASET_COLUMN_INVALID_IDENTIFIER", {
        path: column.name,
        message: `Column name '${column.name}' is not a valid PostgreSQL identifier`,
      });
    }
    if (!sourceColumnNames.has(column.name)) {
      return snapshotError(422, "DATASET_COLUMN_MISSING", {
        path: column.name,
        message: `Column '${column.name}' no longer exists in source table '${definition.sourceTable}'`,
      });
    }
    const sqlType = sourceSqlTypeByName.get(column.name);
    if (sqlType && TIMEZONE_LESS_TYPES.has(sqlType)) {
      return snapshotError(422, "DATASET_COLUMN_TIMEZONE_REQUIRED", {
        path: column.name,
        message: `Column '${column.name}' has type '${sqlType}' which carries no timezone; use 'timestamptz' so the snapshot does not depend on the API server's local timezone`,
      });
    }
  }

  const numericColumnIndexes: number[] = [];
  for (const [index, column] of columns.entries()) {
    const sqlType = sourceSqlTypeByName.get(column.name);
    if (sqlType && PRECISE_NUMERIC_TYPES.has(sqlType)) {
      numericColumnIndexes.push(index);
    }
  }

  const quotedColumns = columns.map((column) => `"${column.name}"`).join(", ");
  const timeColumn = columns.find((column) => column.role === "time");
  const orderColumns = timeColumn
    ? [timeColumn, ...columns.filter((column) => column.name !== timeColumn.name)]
    : columns;
  const orderBy = orderColumns
    .map((column) => `"${column.name}" ASC NULLS LAST`)
    .join(", ");

  const sql = `SELECT ${quotedColumns} FROM "${definition.sourceSchema}"."${definition.sourceTable}" ORDER BY ${orderBy}`;
  const storeColumns: SnapshotStorageColumn[] = columns.map((column) => ({
    name: column.name,
    dataType: column.dataType,
    isNullable: column.isNullable,
  }));

  const schemaSummary: SchemaSummary = {
    sourceTable: definition.sourceTable,
    columns: columns.map((column) => ({
      name: column.name,
      role: column.role,
      dataType: column.dataType,
      position: column.position,
      isNullable: column.isNullable,
    })),
  };

  let written: WrittenSnapshot;
  let iterator: AsyncIterator<SnapshotStorageRow[], void, void> | undefined;
  try {
    // Bound only the cursor scan so a slow source scan fails fast without
    // capping the subsequent quota check and snapshot insert. The setting is
    // LOCAL and is reset explicitly after the write and automatically on
    // commit/rollback.
    await pool.query("SELECT set_config('statement_timeout', $1, true)", [
      `${resolveCursorTimeoutMs()}ms`,
    ]);

    const streamIterator = streamSourceRows(
      pool,
      columns,
      sql,
      numericColumnIndexes,
      resolveCursorBatchSize(),
    )[Symbol.asyncIterator]();
    iterator = streamIterator as AsyncIterator<SnapshotStorageRow[], void, void>;

    const first = await iterator.next();
    if (first.done || first.value.length === 0) {
      return snapshotError(422, "SNAPSHOT_EMPTY_TABLE", {
        path: "sourceTable",
        message: `Source table '${definition.sourceTable}' contains no rows`,
      });
    }

    const rowLimit = resolveSnapshotRowLimit();
    let scannedRows = 0;
    const rows = (async function* () {
      try {
        scannedRows += first.value.length;
        if (scannedRows > rowLimit) {
          throw new SnapshotRowLimitError(scannedRows, rowLimit);
        }
        yield first.value;
        for (;;) {
          const next = await iterator!.next();
          if (next.done) return;
          scannedRows += next.value.length;
          if (scannedRows > rowLimit) {
            throw new SnapshotRowLimitError(scannedRows, rowLimit);
          }
          yield next.value;
        }
      } finally {
        await iterator!.return?.().catch(() => {});
      }
    })();

    written = await storage.writeSnapshot({
      columns: storeColumns,
      rows,
    });
  } catch (error) {
    if (error instanceof NumericPrecisionLossError) {
      return snapshotError(422, "DATASET_COLUMN_PRECISION_LOSS", {
        path: error.columnName,
        message: `Value '${error.value}' in column '${error.columnName}' has more precision than a float64 can store; the snapshot would silently round it`,
      });
    }

    if (error instanceof SnapshotRowLimitError) {
      return snapshotError(422, "SNAPSHOT_ROW_LIMIT_EXCEEDED", {
        path: "sourceTable",
        message: `The snapshot exceeds the maximum allowed row count of ${error.limit}`,
      });
    }

    console.error("Snapshot write failed", error);
    return snapshotError(502, "SNAPSHOT_STORAGE_FAILED", {
      path: "storage",
      message: "The snapshot could not be written to storage",
    });
  } finally {
    await iterator?.return?.().catch(() => {});
    await pool.query("SELECT set_config('statement_timeout', '0', true)").catch(() => {});
  }

  // The Parquet size is only known once the file is encoded, so the tenant
  // quota is checked after the write but before the row is inserted. When the
  // quota would be exceeded the file is removed and no snapshot row is created.
  try {
    const fileSize = (await stat(storage.resolveUri(written.uri))).size;
    await enforceTenantStorageQuota(
      pool,
      schemaName,
      (uri) => storage.resolveUri(uri),
      fileSize,
    );
  } catch (error) {
    await storage.deleteSnapshot(written.uri).catch(() => {});
    if (error instanceof TenantStorageQuotaExceededError) {
      return snapshotError(429, "STORAGE_QUOTA_EXCEEDED", {
        path: "storage",
        message: "Storing this snapshot would exceed the tenant storage quota",
      });
    }
    console.error("Snapshot quota check or stat failed", error);
    return snapshotError(502, "SNAPSHOT_STORAGE_FAILED", {
      path: "storage",
      message: "The snapshot could not be written to storage",
    });
  }

  try {
    await pool.query("SAVEPOINT snapshot_insert");
    const snapshot = await insertDatasetSnapshot(pool, {
      datasetDefinitionId: definitionId,
      storageUri: written.uri,
      contentSha256: written.contentSha256,
      rowCount: written.rowCount,
      schemaSummary,
    });
    await pool.query("RELEASE SAVEPOINT snapshot_insert");

    return {
      ok: true,
      body: {
        id: snapshot.id,
        datasetDefinitionId: definitionId,
        storageUri: written.uri,
        format: "parquet",
        contentSha256: written.contentSha256,
        rowCount: written.rowCount,
        schemaSummary,
        frozenAt: snapshot.frozenAt.toISOString(),
      },
    };
  } catch (error) {
    await pool.query("ROLLBACK TO SAVEPOINT snapshot_insert").catch(() => {});
    await storage.deleteSnapshot(written.uri).catch(() => {});

    if (isUniqueViolation(error)) {
      const existing = await loadDatasetSnapshotByContent(
        pool,
        definitionId,
        written.contentSha256,
      );

      if (existing) {
        return {
          ok: true,
          body: {
            id: existing.id,
            datasetDefinitionId: definitionId,
            storageUri: existing.storageUri,
            format: "parquet",
            contentSha256: existing.contentSha256,
            rowCount: existing.rowCount,
            schemaSummary: existing.schemaSummary,
            frozenAt: existing.frozenAt.toISOString(),
          },
        };
      }
    }

    throw error;
  }
}

async function* streamSourceRows(
  client: PoolClient,
  columns: LoadedDatasetColumn[],
  sql: string,
  numericColumnIndexes: number[],
  batchSize: number,
): AsyncGenerator<SnapshotStorageRow[], void, void> {
  const cursorName = `snapshot_cursor_${randomUUID().replaceAll("-", "")}`;
  await client.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${sql}`);
  try {
    for (;;) {
      const { rows } = await client.query<Record<string, unknown>>(
        `FETCH FORWARD ${batchSize} FROM ${cursorName}`,
      );
      if (rows.length === 0) return;

      const batch = rows.map((row) =>
        columns.map((column) => {
          const value = row[column.name] ?? null;
          return value as string | number | boolean | bigint | Date | null;
        }),
      );

      validateNumericPrecision(columns, numericColumnIndexes, batch);

      yield batch;
    }
  } finally {
    await client.query(`CLOSE ${cursorName}`).catch(() => {});
  }
}

function validateNumericPrecision(
  columns: LoadedDatasetColumn[],
  indexes: number[],
  batch: SnapshotStorageRow[],
): void {
  for (const row of batch) {
    for (const index of indexes) {
      const value = row[index];
      if (!isFloat64LosslessDecimal(value)) {
        throw new NumericPrecisionLossError(columns[index]!.name, String(value));
      }
    }
  }
}

export async function verifyDatasetSnapshot(
  storage: SnapshotStorage,
  uri: string,
  contentSha256: string,
): Promise<boolean> {
  return storage.verifySnapshot(uri, contentSha256);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

class SnapshotRowLimitError extends Error {
  readonly scanned: number;
  readonly limit: number;

  constructor(scanned: number, limit: number) {
    super(`Snapshot exceeds the row limit of ${limit}`);
    this.name = "SnapshotRowLimitError";
    this.scanned = scanned;
    this.limit = limit;
  }
}

function snapshotError(
  status: number,
  code: DatasetSnapshotError["error"]["code"],
  issue: { path: string; message: string },
): CreateDatasetSnapshotResult {
  return {
    ok: false,
    status,
    body: {
      error: {
        code,
        message: issue.message,
        issues: [issue],
      },
    },
  };
}
