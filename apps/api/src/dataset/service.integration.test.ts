import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DatasetDefinitionResponseDto } from "@ampersand/contracts";

import { createDatasetDefinition } from "./service";
import { createDatasetSnapshot } from "./snapshot-service";
import { createSnapshotStorage } from "./storage";
import { tenantDataSchemaName } from "./tenant-data-schema";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const datasetIntegrationPool = new Pool({ connectionString: databaseUrl });
const schemaName = "tenant_ampersand_dev";
const dataSchemaName = tenantDataSchemaName(schemaName);
const userId = "22222222-2222-4222-8222-222222222222";

FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  ),
);
FormatRegistry.Set("date-time", (value) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value,
  ),
);

const validInput = {
  name: "Energy predictor integration",
  sourceTable: "energy_readings",
  features: [
    { name: "temperature", description: "Outside temperature", unit: "celsius" },
    { name: "occupancy", description: "Number of occupants", unit: "people" },
  ],
  target: { name: "energy_usage", description: "Energy", unit: "kWh" },
  timeColumn: { name: "recorded_at", description: "Measurement time" },
};

describe("dataset definition database integration", () => {
  afterAll(async () => {
    await datasetIntegrationPool.end();
  });

  test("creates a dataset definition from a real tenant table", async () => {
    const client = await datasetIntegrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${dataSchemaName}`);

      await client.query(`
        CREATE TABLE ${dataSchemaName}.energy_readings (
          id bigserial PRIMARY KEY,
          recorded_at timestamptz NOT NULL,
          temperature double precision NOT NULL,
          occupancy integer,
          energy_usage numeric NOT NULL
        )
      `);

      const result = await createDatasetDefinition(
        client,
        schemaName,
        userId,
        validInput,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected successful definition");

      expect(Value.Check(DatasetDefinitionResponseDto, result.body)).toBe(true);
      expect(result.body).toMatchObject({
        name: validInput.name,
        sourceTable: "energy_readings",
        targetColumn: "energy_usage",
        timeColumn: "recorded_at",
      });
      expect(result.body.columns).toHaveLength(4);
      expect(result.body.columns.map((column) => column.position)).toEqual([
        0, 1, 2, 3,
      ]);
      expect(result.body.columns.map((column) => column.role)).toEqual([
        "feature",
        "feature",
        "target",
        "time",
      ]);

      const stored = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM dataset_definitions WHERE id = $1`,
        [result.body.id],
      );
      expect(stored.rows[0]?.count).toBe("1");

      const columns = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM dataset_columns WHERE dataset_definition_id = $1`,
        [result.body.id],
      );
      expect(columns.rows[0]?.count).toBe("4");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  test("rejects a missing source table with 404", async () => {
    const client = await datasetIntegrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const result = await createDatasetDefinition(
        client,
        schemaName,
        userId,
        { ...validInput, sourceTable: "does_not_exist" },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.body.error.code).toBe("SOURCE_TABLE_NOT_FOUND");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  test("rejects a platform-managed table with 403", async () => {
    const client = await datasetIntegrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const result = await createDatasetDefinition(
        client,
        schemaName,
        userId,
        { ...validInput, sourceTable: "dataset_definitions" },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.body.error.code).toBe("SOURCE_TABLE_NOT_ALLOWED");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  test("rejects a view as a dataset source with 403", async () => {
    const client = await datasetIntegrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${dataSchemaName}`);
      await client.query(`
        CREATE VIEW ${dataSchemaName}.energy_readings_view AS
        SELECT 1::double precision AS temperature,
               2::numeric AS energy_usage
      `);

      const result = await createDatasetDefinition(
        client,
        schemaName,
        userId,
        {
          ...validInput,
          sourceTable: "energy_readings_view",
          features: [{ name: "temperature", description: "Temperature" }],
          target: { name: "energy_usage", description: "Energy" },
          timeColumn: undefined,
        },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.body.error.code).toBe("SOURCE_TABLE_NOT_ALLOWED");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  test("reuses identical snapshot content for one dataset definition", async () => {
    const client = await datasetIntegrationPool.connect();
    const storageRoot = await mkdtemp(join(tmpdir(), "ampersand-snapshot-reuse-"));

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${dataSchemaName}`);
      await client.query(`
        CREATE TABLE ${dataSchemaName}.snapshot_reuse_readings (
          temperature double precision NOT NULL,
          energy_usage double precision NOT NULL
        )
      `);
      await client.query(`
        INSERT INTO ${dataSchemaName}.snapshot_reuse_readings
          (temperature, energy_usage)
        VALUES (20, 100), (25, 130)
      `);

      const definition = await createDatasetDefinition(
        client,
        schemaName,
        userId,
        {
          name: "Snapshot reuse integration",
          sourceTable: "snapshot_reuse_readings",
          features: [{ name: "temperature", description: "Temperature" }],
          target: { name: "energy_usage", description: "Energy" },
        },
      );
      if (!definition.ok) throw new Error("expected successful definition");

      const storage = createSnapshotStorage(storageRoot);
      const first = await createDatasetSnapshot(
        client,
        schemaName,
        definition.body.id,
        storage,
      );
      const second = await createDatasetSnapshot(
        client,
        schemaName,
        definition.body.id,
        storage,
      );

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.body.id).toBe(first.body.id);

      const stored = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM dataset_snapshots
         WHERE dataset_definition_id = $1`,
        [definition.body.id],
      );
      expect(stored.rows[0]?.count).toBe("1");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
