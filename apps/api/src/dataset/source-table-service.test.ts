import { describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";

import { importCsvSourceTable } from "./source-table-service";

type RecordedQuery = { sql: string; values: unknown[] | undefined };

function createClient(tableExists = false): {
  client: PoolClient;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (sql.includes("information_schema.tables")) {
        return { rows: tableExists ? [{ exists: 1 }] : [], rowCount: tableExists ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return { client, queries };
}

describe("CSV source-table import", () => {
  test("infers column types and inserts rows into the tenant schema", async () => {
    const { client, queries } = createClient();
    const csv = [
      "temperature,occupancy,is_holiday,recorded_at,note",
      "21.5,3,false,2026-08-26T09:00:00Z,morning",
      "23.1,4,true,2026-08-26T10:00:00Z,",
    ].join("\n");

    const result = await importCsvSourceTable(
      client,
      "tenant_ampersand_dev",
      "energy_readings",
      csv,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table).toEqual({
      name: "energy_readings",
      rowCount: 2,
      columns: [
        { name: "temperature", dataType: "number", isNullable: false },
        { name: "occupancy", dataType: "integer", isNullable: false },
        { name: "is_holiday", dataType: "boolean", isNullable: false },
        { name: "recorded_at", dataType: "datetime", isNullable: false },
        { name: "note", dataType: "text", isNullable: true },
      ],
    });
    expect(queries.some(({ sql }) => sql.includes('CREATE SCHEMA IF NOT EXISTS "tenant_ampersand_dev_data"'))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('CREATE TABLE "tenant_ampersand_dev_data"."energy_readings"'))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('INSERT INTO "tenant_ampersand_dev_data"."energy_readings"'))).toBe(true);
  });

  test("rejects unsafe table names before querying PostgreSQL", async () => {
    const { client, queries } = createClient();
    const result = await importCsvSourceTable(client, "tenant_a", "readings; DROP TABLE users", "value\n1");
    expect(result).toMatchObject({ ok: false, status: 400, code: "INVALID_TABLE_NAME" });
    expect(queries).toHaveLength(0);
  });

  test("rejects invalid column names", async () => {
    const { client, queries } = createClient();
    const result = await importCsvSourceTable(client, "tenant_a", "readings", "outside temperature\n21");
    expect(result).toMatchObject({ ok: false, status: 422, code: "INVALID_CSV_HEADERS" });
    expect(queries).toHaveLength(0);
  });

  test("does not overwrite an existing source table", async () => {
    const { client, queries } = createClient(true);
    const result = await importCsvSourceTable(client, "tenant_a", "readings", "value\n1");
    expect(result).toMatchObject({ ok: false, status: 409, code: "SOURCE_TABLE_EXISTS" });
    expect(queries.some(({ sql }) => sql.startsWith("CREATE TABLE"))).toBe(false);
  });
});
