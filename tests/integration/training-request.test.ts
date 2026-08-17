import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Value } from "@sinclair/typebox/value";
import {
  TrainingJobRequestErrorDto,
  TrainingJobResponseDto,
  type CreateTrainingJobInput,
} from "@ampersand/contracts";
import type pg from "pg";

import { withTenantTransaction } from "../../apps/api/src/database/tenant-transaction";
import {
  createTrainingJob,
  createTrainingJobRepository,
} from "../../apps/api/src/training/service";
import { beginScoped, createPool, resolveTenantSchema } from "./support/db";
import { registerFormats } from "./support/contracts";

registerFormats();

const userId = "22222222-2222-4222-8222-222222222222";
const sourceTable = "training_request_energy_readings";

function digest(): string {
  return createHash("sha256").update(Math.random().toString()).digest("hex");
}

type SeededDataset = {
  definitionId: string;
  columns: { id: string }[];
};

async function seedDefinition(
  client: pg.PoolClient,
  schemaName: string,
  name: string,
): Promise<SeededDataset> {
  const dataset = await client.query<{ id: string }>(
    `INSERT INTO dataset_definitions
      (name, source_schema, source_table, target_column, time_column)
     VALUES ($1, $2, $3, 'energy_usage', 'recorded_at')
     RETURNING id`,
    [name, schemaName, sourceTable],
  );
  const definitionId = dataset.rows[0]!.id;

  const columns = await client.query<{ id: string }>(
    `INSERT INTO dataset_columns
      (dataset_definition_id, column_name, role, data_type, description, unit, is_nullable, position)
     VALUES
      ($1, 'temperature', 'feature', 'number', 'Outside temperature', 'celsius', false, 0),
      ($1, 'occupancy', 'feature', 'integer', 'Number of occupants', 'people', false, 1),
      ($1, 'energy_usage', 'target', 'number', 'Building energy consumption', 'kWh', false, 2),
      ($1, 'recorded_at', 'time', 'datetime', 'Measurement time', NULL, false, 3)
     RETURNING id`,
    [definitionId],
  );

  return { definitionId, columns: columns.rows };
}

async function seedSnapshot(
  client: pg.PoolClient,
  definitionId: string,
  rowCount = 100,
): Promise<{ id: string; contentSha256: string }> {
  const contentSha256 = digest();
  const snapshot = await client.query<{ id: string }>(
    `INSERT INTO dataset_snapshots
      (dataset_definition_id, storage_uri, storage_format, content_sha256, row_count, schema_summary, frozen_at)
     VALUES ($1, $2, 'parquet', $3, $4, $5, now())
     RETURNING id`,
    [
      definitionId,
      `artifacts/mock-${contentSha256}.parquet`,
      contentSha256,
      rowCount,
      JSON.stringify({ sourceTable, columns: [] }),
    ],
  );

  return { id: snapshot.rows[0]!.id, contentSha256 };
}

async function requestJob(
  client: pg.PoolClient,
  schemaName: string,
  input: CreateTrainingJobInput,
) {
  return createTrainingJob(
    createTrainingJobRepository(client),
    schemaName,
    userId,
    input,
  );
}

const COMMITTED_FIXTURE_NAMES = [
  "Concurrent duplicate training",
  "Concurrent quota training one",
  "Concurrent quota training two",
];

async function deleteTrainingFixturesByName(
  pool: pg.Pool,
  schemaName: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) {
    return;
  }

  const client = await pool.connect();
  try {
    await beginScoped(client, schemaName);

    await client.query(
      `DELETE FROM training_jobs
       WHERE dataset_snapshot_id IN (
         SELECT ds.id
         FROM dataset_snapshots ds
         JOIN dataset_definitions dd ON dd.id = ds.dataset_definition_id
         WHERE dd.name = ANY($1::text[])
       )`,
      [names],
    );

    await client.query(
      `DELETE FROM dataset_snapshots
       WHERE dataset_definition_id IN (
         SELECT id FROM dataset_definitions WHERE name = ANY($1::text[])
       )`,
      [names],
    );

    await client.query(
      `DELETE FROM dataset_columns
       WHERE dataset_definition_id IN (
         SELECT id FROM dataset_definitions WHERE name = ANY($1::text[])
       )`,
      [names],
    );

    await client.query(
      `DELETE FROM dataset_definitions WHERE name = ANY($1::text[])`,
      [names],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

describe("training request integration", () => {
  let pool: pg.Pool;
  let schemaName: string;

  beforeAll(async () => {
    pool = createPool();
    schemaName = await resolveTenantSchema(
      pool,
      process.env.DEV_TENANT_SUBDOMAIN ?? "ampersand-dev",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates a queued job from the latest valid snapshot", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, schemaName);

      const { definitionId } = await seedDefinition(
        client,
        schemaName,
        "Latest snapshot training",
      );
      const first = await seedSnapshot(client, definitionId);
      await client.query(
        `UPDATE dataset_snapshots SET frozen_at = now() - interval '1 hour' WHERE id = $1`,
        [first.id],
      );
      const latest = await seedSnapshot(client, definitionId);

      const result = await requestJob(client, schemaName, { datasetDefinitionId: definitionId });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected successful creation");

      expect(result.status).toBe(201);
      expect(result.body.datasetSnapshotId).toBe(latest.id);
      expect(result.body.status).toBe("queued");
      expect(Value.Check(TrainingJobResponseDto, result.body)).toBe(true);

      const stored = await client.query<{
        fingerprint: string;
        dataset_snapshot_id: string;
        status: string;
        progress_percent: number;
        progress_message: string;
      }>(
        `SELECT fingerprint, dataset_snapshot_id, status, progress_percent, progress_message
         FROM training_jobs WHERE id = $1`,
        [result.body.id],
      );
      expect(stored.rows[0]).toMatchObject({
        fingerprint: result.body.fingerprint,
        dataset_snapshot_id: latest.id,
        status: "queued",
        progress_percent: 0,
        progress_message: "Waiting for a worker",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("rejects a sequential duplicate with a structured 409", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, schemaName);

      const { definitionId } = await seedDefinition(
        client,
        schemaName,
        "Sequential duplicate training",
      );
      await seedSnapshot(client, definitionId);

      const first = await requestJob(client, schemaName, { datasetDefinitionId: definitionId });
      expect(first.ok).toBe(true);

      const second = await requestJob(client, schemaName, { datasetDefinitionId: definitionId });

      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected duplicate rejection");
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("DUPLICATE_TRAINING_REQUEST");
      expect(Value.Check(TrainingJobRequestErrorDto, second.body)).toBe(true);

      const count = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM training_jobs`,
      );
      expect(count.rows[0]?.count).toBe("1");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("rejects a definition with no snapshot", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, schemaName);

      const { definitionId } = await seedDefinition(
        client,
        schemaName,
        "Missing snapshot training",
      );

      const result = await requestJob(client, schemaName, { datasetDefinitionId: definitionId });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe("SNAPSHOT_NOT_FOUND");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("rejects a definition that is no longer trainable", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, schemaName);

      const { definitionId, columns } = await seedDefinition(
        client,
        schemaName,
        "Not trainable training",
      );
      await seedSnapshot(client, definitionId);
      await client.query(
        `DELETE FROM dataset_columns WHERE id = $1 AND role = 'target'`,
        [columns[2]!.id],
      );

      const result = await requestJob(client, schemaName, { datasetDefinitionId: definitionId });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected rejection");
      expect(result.status).toBe(422);
      expect(result.body.error.code).toBe("DATASET_NOT_TRAINABLE");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("rejects when the tenant quota is exhausted", async () => {
    const client = await pool.connect();
    const previousLimit = process.env.TRAINING_MAX_ACTIVE_JOBS;
    process.env.TRAINING_MAX_ACTIVE_JOBS = "1";
    try {
      await beginScoped(client, schemaName);

      const { definitionId } = await seedDefinition(
        client,
        schemaName,
        "Quota training",
      );
      await seedSnapshot(client, definitionId);

      const first = await requestJob(client, schemaName, { datasetDefinitionId: definitionId });
      expect(first.ok).toBe(true);

      const second = await requestJob(client, schemaName, { datasetDefinitionId: definitionId });

      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected quota rejection");
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe("TRAINING_QUOTA_EXCEEDED");
    } finally {
      process.env.TRAINING_MAX_ACTIVE_JOBS = previousLimit;
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});

describe("training request concurrency integration", () => {
  let pool: pg.Pool;
  let schemaName: string;

  beforeAll(async () => {
    pool = createPool();
    schemaName = await resolveTenantSchema(
      pool,
      process.env.DEV_TENANT_SUBDOMAIN ?? "ampersand-dev",
    );
    await deleteTrainingFixturesByName(pool, schemaName, COMMITTED_FIXTURE_NAMES);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates exactly one job from concurrent duplicate requests", async () => {
    const setup = await pool.connect();
    let definitionId: string;
    try {
      await beginScoped(setup, schemaName);
      ({ definitionId } = await seedDefinition(
        setup,
        schemaName,
        "Concurrent duplicate training",
      ));
      await seedSnapshot(setup, definitionId);
      await setup.query("COMMIT");
    } catch (error) {
      await setup.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      setup.release();
    }

    try {
      const results = await Promise.all([
        withTenantTransaction(schemaName, (client) =>
          createTrainingJob(
            createTrainingJobRepository(client),
            schemaName,
            userId,
            { datasetDefinitionId: definitionId },
          ),
        ),
        withTenantTransaction(schemaName, (client) =>
          createTrainingJob(
            createTrainingJobRepository(client),
            schemaName,
            userId,
            { datasetDefinitionId: definitionId },
          ),
        ),
      ]);

      const successful = results.filter((result) => result.ok);
      const rejected = results.filter((result) => !result.ok);

      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (!rejected[0]) throw new Error("expected a rejected request");
      if (rejected[0].ok) throw new Error("expected rejection");
      expect(rejected[0].status).toBe(409);
      expect(rejected[0].body.error.code).toBe("DUPLICATE_TRAINING_REQUEST");

      const check = await pool.connect();
      try {
        await beginScoped(check, schemaName);
        const count = await check.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM training_jobs tj
           JOIN dataset_snapshots ds ON ds.id = tj.dataset_snapshot_id
           WHERE ds.dataset_definition_id = $1`,
          [definitionId],
        );
        expect(count.rows[0]?.count).toBe("1");
      } finally {
        await check.query("ROLLBACK").catch(() => {});
        check.release();
      }
    } finally {
      await deleteTrainingFixturesByName(
        pool,
        schemaName,
        ["Concurrent duplicate training"],
      );
    }
  });

  it("never exceeds the tenant quota under concurrent distinct requests", async () => {
    const setup = await pool.connect();
    let firstDefinitionId: string;
    let secondDefinitionId: string;
    try {
      await beginScoped(setup, schemaName);
      const first = await seedDefinition(
        setup,
        schemaName,
        "Concurrent quota training one",
      );
      await seedSnapshot(setup, first.definitionId);
      const second = await seedDefinition(
        setup,
        schemaName,
        "Concurrent quota training two",
      );
      await seedSnapshot(setup, second.definitionId);
      firstDefinitionId = first.definitionId;
      secondDefinitionId = second.definitionId;
      await setup.query("COMMIT");
    } catch (error) {
      await setup.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      setup.release();
    }

    const previousLimit = process.env.TRAINING_MAX_ACTIVE_JOBS;
    process.env.TRAINING_MAX_ACTIVE_JOBS = "1";
    try {
      const results = await Promise.all([
        withTenantTransaction(schemaName, (client) =>
          createTrainingJob(
            createTrainingJobRepository(client),
            schemaName,
            userId,
            { datasetDefinitionId: firstDefinitionId },
          ),
        ),
        withTenantTransaction(schemaName, (client) =>
          createTrainingJob(
            createTrainingJobRepository(client),
            schemaName,
            userId,
            { datasetDefinitionId: secondDefinitionId },
          ),
        ),
      ]);

      const successful = results.filter((result) => result.ok);
      const rejected = results.filter((result) => !result.ok);

      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (!rejected[0]) throw new Error("expected a rejected request");
      if (rejected[0].ok) throw new Error("expected rejection");
      expect(rejected[0].status).toBe(429);
      expect(rejected[0].body.error.code).toBe("TRAINING_QUOTA_EXCEEDED");

      const check = await pool.connect();
      try {
        await beginScoped(check, schemaName);
        const count = await check.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM training_jobs tj
           JOIN dataset_snapshots ds ON ds.id = tj.dataset_snapshot_id
           WHERE ds.dataset_definition_id IN ($1, $2)`,
          [firstDefinitionId, secondDefinitionId],
        );
        expect(count.rows[0]?.count).toBe("1");
      } finally {
        await check.query("ROLLBACK").catch(() => {});
        check.release();
      }
    } finally {
      process.env.TRAINING_MAX_ACTIVE_JOBS = previousLimit;
      await deleteTrainingFixturesByName(
        pool,
        schemaName,
        ["Concurrent quota training one", "Concurrent quota training two"],
      );
    }
  });
});
