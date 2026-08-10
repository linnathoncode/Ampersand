import { afterAll, describe, expect, test } from "bun:test";
import pg from "pg";

import {
  generateAndStoreModelToolDefinition,
  getDiscoverableTools,
} from "./service";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const integrationPool = new Pool({ connectionString: databaseUrl });
const schemaName = "tenant_ampersand_dev";

describe("tool-definition database integration", () => {
  afterAll(async () => {
    await integrationPool.end();
  });

  test("stores and discovers a tool for a published model", async () => {
    const client = await integrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const model = await client.query<{ id: string }>(
        `
          SELECT mv.id
          FROM model_versions mv
          WHERE mv.status = 'published'
            AND mv.is_active = true
            AND EXISTS (
              SELECT 1
              FROM model_artifacts ma
              WHERE ma.model_version_id = mv.id
                AND ma.is_active = true
            )
            AND EXISTS (
              SELECT 1
              FROM model_features mf
              WHERE mf.model_version_id = mv.id
                AND mf.is_active = true
            )
          LIMIT 1
        `,
      );

      const modelVersionId = model.rows[0]?.id;

      if (!modelVersionId) {
        throw new Error("No eligible published model version is available");
      }

      const user = await client.query<{ id: string }>(
        `
          SELECT id
          FROM users
          WHERE is_active = true
          LIMIT 1
        `,
      );

      const createdBy = user.rows[0]?.id;

      if (!createdBy) {
        throw new Error("No active tenant user is available");
      }

      await client.query(
        `
          DELETE FROM inference_calls
          WHERE tool_definition_id IN (
            SELECT id
            FROM tool_definitions
            WHERE model_version_id = $1
          )
        `,
        [modelVersionId],
      );

      await client.query(
        "DELETE FROM tool_definitions WHERE model_version_id = $1",
        [modelVersionId],
      );

      const storedResult = await generateAndStoreModelToolDefinition(
        client,
        schemaName,
        modelVersionId,
        createdBy,
      );

      expect(storedResult.ok).toBe(true);

      if (!storedResult.ok) {
        throw new Error("Expected tool storage to succeed");
      }

      expect(storedResult.body.modelVersionId).toBe(modelVersionId);
      expect(storedResult.body.schemaSha256).toMatch(/^[a-f0-9]{64}$/);

      const discoverableTools = await getDiscoverableTools(
        client,
        schemaName,
      );

      const discoveredTool = discoverableTools.find(
        (tool) => tool.modelVersionId === modelVersionId,
      );

      console.log(
        "Tool storage and discovery:",
        JSON.stringify(
          {
            storedToolName: storedResult.body.toolName,
            schemaSha256: storedResult.body.schemaSha256,
            discoverableToolCount: discoverableTools.length,
            discoveredTool: discoveredTool
              ? {
                  toolName: discoveredTool.toolName,
                  requiredInputs: discoveredTool.inputSchema.required,
                }
              : null,
          },
          null,
          2,
        ),
      );

      expect(discoveredTool).toBeDefined();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
