import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { tableFromIPC } from "apache-arrow";
import { readParquet } from "parquet-wasm/node";
import { Value } from "@sinclair/typebox/value";
import {
  DatasetSnapshotErrorDto,
  DatasetSnapshotRecordDto,
  SchemaSummaryDto,
} from "@ampersand/contracts";
import type pg from "pg";

import { createDatasetDefinition } from "../../apps/api/src/dataset/service";
import {
  createDatasetSnapshot,
  verifyDatasetSnapshot,
} from "../../apps/api/src/dataset/snapshot-service";
import {
  createSnapshotStorage,
  type SnapshotStorage,
} from "../../apps/api/src/dataset/storage";
import { beginScoped, createPool, resolveTenantSchema } from "./support/db";
import { registerFormats } from "./support/contracts";

registerFormats();

const userId = "22222222-2222-4222-8222-222222222222";

const sourceTable = "snapshot_test_energy_readings";

const validInput = {
  name: "Energy predictor snapshot",
  sourceTable,
  features: [
    { name: "temperature", description: "Outside temperature", unit: "celsius" },
    { name: "occupancy", description: "Number of occupants", unit: "people" },
  ],
  target: { name: "energy_usage", description: "Energy", unit: "kWh" },
  timeColumn: { name: "recorded_at", description: "Measurement time" },
};

describe("dataset snapshot integration", () => {
  let pool: pg.Pool;
  let tenantSchema: string;
  let storage: SnapshotStorage;
  let storageDir: string;

  beforeAll(async () => {
    pool = createPool();
    tenantSchema = await resolveTenantSchema(
      pool,
      process.env.DEV_TENANT_SUBDOMAIN ?? "ampersand-dev",
    );
    storageDir = await mkdtemp(join(tmpdir(), "ampersand-snapshot-"));
    storage = createSnapshotStorage(storageDir);
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
    await pool?.end();
  });

  async function withDefinition(): Promise<{ client: pg.PoolClient; id: string }> {
    const client = await pool.connect();
    try {
      await beginScoped(client, tenantSchema);
      await client.query(`
        CREATE TABLE ${sourceTable} (
          id bigserial PRIMARY KEY,
          recorded_at timestamptz NOT NULL,
          temperature double precision NOT NULL,
          occupancy integer,
          energy_usage numeric NOT NULL
        )
      `);
      const result = await createDatasetDefinition(client, tenantSchema, userId, validInput);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected successful definition");
      return { client, id: result.body.id };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      throw error;
    }
  }

  async function insertRows(
    client: pg.PoolClient,
    rows: [string, number, number | null, number][],
  ): Promise<void> {
    for (const [recordedAt, temperature, occupancy, usage] of rows) {
      await client.query(
        `INSERT INTO ${sourceTable} (recorded_at, temperature, occupancy, energy_usage) VALUES ($1, $2, $3, $4)`,
        [recordedAt, temperature, occupancy, usage],
      );
    }
  }

  async function cleanup(client: pg.PoolClient): Promise<void> {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }

  it("creates a snapshot record and a matching Parquet file", async () => {
    const { client, id } = await withDefinition();
    try {
      await insertRows(client, [
        ["2026-08-01T00:00:00Z", 21.5, 3, 100],
        ["2026-08-02T00:00:00Z", 18.2, null, 88],
        ["2026-08-03T00:00:00Z", 24.0, 4, 130],
      ]);

      const result = await createDatasetSnapshot(client, tenantSchema, id, storage);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected successful snapshot");

      expect(Value.Check(DatasetSnapshotRecordDto, result.body)).toBe(true);
      expect(result.body).toMatchObject({
        datasetDefinitionId: id,
        format: "parquet",
        rowCount: 3,
      });

      const stored = await client.query<{ row_count: string; storage_uri: string }>(
        `SELECT storage_uri, row_count FROM dataset_snapshots WHERE id = $1`,
        [result.body.id],
      );
      expect(stored.rows[0]?.row_count).toBe("3");
      expect(stored.rows[0]?.storage_uri).toBe(result.body.storageUri);

      const file = await readFile(storage.resolveUri(result.body.storageUri));
      const actualHash = createHash("sha256").update(file).digest("hex");
      expect(actualHash).toBe(result.body.contentSha256);

      const arrowTable = tableFromIPC(readParquet(file).intoIPCStream());
      expect(arrowTable.schema.fields.map((field) => field.name)).toEqual([
        "temperature",
        "occupancy",
        "energy_usage",
        "recorded_at",
      ]);
      expect(arrowTable.numRows).toBe(3);

      const times = arrowTable
        .getChild("recorded_at")!
        .toArray()
        .map((value: bigint | null) => Number(value));
      expect([...times].sort((a, b) => a - b)).toEqual(times);

      expect(Value.Check(SchemaSummaryDto, result.body.schemaSummary)).toBe(true);
      expect(result.body.schemaSummary.sourceTable).toBe(sourceTable);
      expect(result.body.schemaSummary.columns.map((column) => column.name)).toEqual([
        "temperature",
        "occupancy",
        "energy_usage",
        "recorded_at",
      ]);
    } finally {
      await cleanup(client);
    }
  });

  it("rejects a missing dataset definition", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, tenantSchema);
      const result = await createDatasetSnapshot(
        client,
        tenantSchema,
        "11111111-1111-4111-8111-111111111111",
        storage,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(404);
        expect(result.body.error.code).toBe("DATASET_DEFINITION_NOT_FOUND");
        expect(Value.Check(DatasetSnapshotErrorDto, result.body)).toBe(true);
      }
    } finally {
      await cleanup(client);
    }
  });

  it("rejects a definition whose source table no longer exists", async () => {
    const { client, id } = await withDefinition();
    try {
      await client.query(`DROP TABLE ${sourceTable}`);
      const result = await createDatasetSnapshot(client, tenantSchema, id, storage);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.body.error.code).toBe("DATASET_SOURCE_TABLE_MISSING");
      }
    } finally {
      await cleanup(client);
    }
  });

  it("rejects an empty source table", async () => {
    const { client, id } = await withDefinition();
    try {
      const result = await createDatasetSnapshot(client, tenantSchema, id, storage);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.body.error.code).toBe("SNAPSHOT_EMPTY_TABLE");
      }
    } finally {
      await cleanup(client);
    }
  });

  it("excludes columns that are not part of the definition", async () => {
    const { client, id } = await withDefinition();
    try {
      await client.query(`ALTER TABLE ${sourceTable} ADD COLUMN notes text`);
      await insertRows(client, [["2026-08-01T00:00:00Z", 21.5, 3, 100]]);

      const result = await createDatasetSnapshot(client, tenantSchema, id, storage);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected successful snapshot");

      const file = await readFile(storage.resolveUri(result.body.storageUri));
      const arrowTable = tableFromIPC(readParquet(file).intoIPCStream());
      expect(arrowTable.schema.fields.map((field) => field.name)).toEqual([
        "temperature",
        "occupancy",
        "energy_usage",
        "recorded_at",
      ]);
    } finally {
      await cleanup(client);
    }
  });

  it("detects a checksum mismatch and cleans up on storage failure", async () => {
    const { client, id } = await withDefinition();
    try {
      await insertRows(client, [["2026-08-01T00:00:00Z", 21.5, 3, 100]]);

      const result = await createDatasetSnapshot(client, tenantSchema, id, storage);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected successful snapshot");

      expect(
        await verifyDatasetSnapshot(
          storage,
          result.body.storageUri,
          result.body.contentSha256,
        ),
      ).toBe(true);
      expect(
        await verifyDatasetSnapshot(storage, result.body.storageUri, "f".repeat(64)),
      ).toBe(false);

      const failingStorage: SnapshotStorage = {
        writeSnapshot: async () => {
          throw new Error("disk full");
        },
        deleteSnapshot: async () => {},
        verifySnapshot: async () => false,
        resolveUri: (uri) => uri,
      };

      const failed = await createDatasetSnapshot(client, tenantSchema, id, failingStorage);
      expect(failed.ok).toBe(false);
      if (!failed.ok) {
        expect(failed.status).toBe(502);
        expect(failed.body.error.code).toBe("SNAPSHOT_STORAGE_FAILED");
      }

      const stored = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dataset_snapshots WHERE dataset_definition_id = $1`,
        [id],
      );
      expect(stored.rows[0]?.count).toBe("1");
    } finally {
      await cleanup(client);
    }
  });

  it("rejects a snapshot when a numeric column loses float64 precision", async () => {
    const { client, id } = await withDefinition();
    try {
      await client.query(
        `INSERT INTO ${sourceTable} (recorded_at, temperature, occupancy, energy_usage) VALUES ($1, $2, $3, $4)`,
        [
          "2026-08-01T00:00:00Z",
          21.5,
          3,
          "10000000000000000000000000000000000000",
        ],
      );

      const result = await createDatasetSnapshot(client, tenantSchema, id, storage);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.body.error.code).toBe("DATASET_COLUMN_PRECISION_LOSS");
        expect(result.body.error.issues[0]?.path).toBe("energy_usage");
      }

      const stored = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dataset_snapshots WHERE dataset_definition_id = $1`,
        [id],
      );
      expect(stored.rows[0]?.count).toBe("0");
    } finally {
      await cleanup(client);
    }
  });

  it("rejects a snapshot whose time column has no timezone", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, tenantSchema);
      await client.query(`
        CREATE TABLE ${sourceTable} (
          id bigserial PRIMARY KEY,
          recorded_at timestamp NOT NULL,
          temperature double precision NOT NULL,
          occupancy integer,
          energy_usage numeric NOT NULL
        )
      `);
      const definition = await createDatasetDefinition(
        client,
        tenantSchema,
        userId,
        validInput,
      );
      expect(definition.ok).toBe(true);
      if (!definition.ok) throw new Error("expected successful definition");

      const result = await createDatasetSnapshot(
        client,
        tenantSchema,
        definition.body.id,
        storage,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.body.error.code).toBe("DATASET_COLUMN_TIMEZONE_REQUIRED");
        expect(result.body.error.issues[0]?.path).toBe("recorded_at");
      }
    } finally {
      await cleanup(client);
    }
  });

  it("rejects a definition whose selected column was dropped from the source table", async () => {
    const { client, id } = await withDefinition();
    try {
      await insertRows(client, [["2026-08-01T00:00:00Z", 21.5, 3, 100]]);
      await client.query(`ALTER TABLE ${sourceTable} DROP COLUMN occupancy`);

      const result = await createDatasetSnapshot(client, tenantSchema, id, storage);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.body.error.code).toBe("DATASET_COLUMN_MISSING");
      }

      const stored = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dataset_snapshots WHERE dataset_definition_id = $1`,
        [id],
      );
      expect(stored.rows[0]?.count).toBe("0");
    } finally {
      await cleanup(client);
    }
  });

  it("returns a 409 when identical content already has a snapshot", async () => {
    const { client, id } = await withDefinition();
    try {
      await insertRows(client, [["2026-08-01T00:00:00Z", 21.5, 3, 100]]);

      const first = await createDatasetSnapshot(client, tenantSchema, id, storage);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("expected first snapshot to succeed");

      const second = await createDatasetSnapshot(client, tenantSchema, id, storage);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe("SNAPSHOT_CONTENT_COLLISION");
      }

      const stored = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM dataset_snapshots WHERE dataset_definition_id = $1`,
        [id],
      );
      expect(stored.rows[0]?.count).toBe("1");
    } finally {
      await cleanup(client);
    }
  });
});
