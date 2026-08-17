import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import type {
  PredictionInputValue,
  ToolInputProperty,
  ToolInputSchema,
} from "@ampersand/contracts";
import { ToolInputSchemaDto } from "@ampersand/contracts";
import { Value } from "@sinclair/typebox/value";
import pg from "pg";

import { validateToolPrediction } from "../../service";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const integrationPool = new Pool({ connectionString: databaseUrl });
const tenantASchema = "tenant_ampersand_dev";

type PublishedToolRow = {
  id: string;
  tool_name: string;
  input_schema: unknown;
};

function validValue(property: ToolInputProperty): PredictionInputValue {
  if (property.enum) return property.enum[0]!;

  switch (property.type) {
    case "boolean":
      return false;
    case "string":
      return "tenant-isolation";
    case "integer":
      return Math.ceil(property.minimum ?? property.maximum ?? 0);
    case "number":
      return property.minimum ?? property.maximum ?? 0;
  }
}

function rejectedInputs(schema: ToolInputSchema) {
  const inputs = Object.fromEntries(
    schema.required.map((name) => [
      name,
      validValue(schema.properties[name]!),
    ]),
  );
  const boundedFeature = Object.entries(schema.properties).find(
    ([, property]) =>
      (property.type === "number" || property.type === "integer") &&
      (property.minimum !== undefined || property.maximum !== undefined),
  );

  if (!boundedFeature) {
    throw new Error("Published tool has no bounded numerical feature");
  }

  const [name, property] = boundedFeature;
  inputs[name] =
    property.maximum !== undefined
      ? property.maximum + 1
      : property.minimum! - 1;

  return inputs;
}

describe("prediction tenant isolation", () => {
  afterAll(async () => {
    await integrationPool.end();
  });

  test("keeps tool discovery and inference audits inside one tenant", async () => {
    const tenantBSchema = `tenant_isolation_${randomUUID().replaceAll("-", "")}`;
    const setupClient = await integrationPool.connect();

    try {
      await setupClient.query(`CREATE SCHEMA ${tenantBSchema}`);
      await setupClient.query(
        `CREATE TABLE ${tenantBSchema}.model_versions
         (LIKE ${tenantASchema}.model_versions INCLUDING ALL)`,
      );
      await setupClient.query(
        `CREATE TABLE ${tenantBSchema}.tool_definitions
         (LIKE ${tenantASchema}.tool_definitions INCLUDING ALL)`,
      );
      await setupClient.query(
        `CREATE TABLE ${tenantBSchema}.inference_calls
         (LIKE ${tenantASchema}.inference_calls INCLUDING ALL)`,
      );
    } finally {
      setupClient.release();
    }

    const client = await integrationPool.connect();

    try {
      await client.query("BEGIN");

      const toolResult = await client.query<PublishedToolRow>(`
        SELECT td.id, td.tool_name, td.input_schema
        FROM ${tenantASchema}.tool_definitions td
        INNER JOIN ${tenantASchema}.model_versions mv
          ON mv.id = td.model_version_id
        WHERE td.is_active = true
          AND mv.is_active = true
          AND mv.status = 'published'
          AND EXISTS (
            SELECT 1
            FROM jsonb_each(td.input_schema->'properties') AS property
            WHERE property.value->>'type' IN ('number', 'integer')
              AND (property.value ? 'minimum' OR property.value ? 'maximum')
          )
        LIMIT 1
      `);
      const tool = toolResult.rows[0];

      if (!tool || !Value.Check(ToolInputSchemaDto, tool.input_schema)) {
        throw new Error("No published bounded tool exists in tenant A");
      }

      const userResult = await client.query<{ id: string }>(`
        SELECT id FROM ${tenantASchema}.users
        WHERE is_active = true
        LIMIT 1
      `);
      const userId = userResult.rows[0]?.id;

      if (!userId) throw new Error("No active tenant A user exists");

      const conversationId = `tenant-isolation-${randomUUID()}`;
      const request = {
        toolName: tool.tool_name,
        conversationId,
        inputs: rejectedInputs(tool.input_schema),
      };
      const tenantAResult = await validateToolPrediction(
        client,
        tenantASchema,
        userId,
        request,
      );
      const tenantBResult = await validateToolPrediction(
        client,
        tenantBSchema,
        userId,
        request,
      );
      const tenantAAudits = await client.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${tenantASchema}.inference_calls
         WHERE conversation_id = $1`,
        [conversationId],
      );
      const tenantBAudits = await client.query<{ count: string }>(
        `SELECT COUNT(*) FROM ${tenantBSchema}.inference_calls
         WHERE conversation_id = $1`,
        [conversationId],
      );

      expect(tenantAResult.kind).toBe("rejected");
      expect(tenantBResult).toMatchObject({ kind: "error", status: 404 });
      expect(Number(tenantAAudits.rows[0]?.count)).toBe(1);
      expect(Number(tenantBAudits.rows[0]?.count)).toBe(0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await integrationPool.query(`DROP SCHEMA ${tenantBSchema} CASCADE`);
    }
  });
});
