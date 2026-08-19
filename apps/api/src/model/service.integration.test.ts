import { afterAll, describe, expect, test } from "bun:test";
import pg from "pg";

import { listPublishedToolDefinitions } from "../tool-definitions/repository";
import { validateToolPrediction } from "../prediction/service";
import {
  getModelRegistry,
  publishCandidateModel,
  retirePublishedModel,
} from "./service";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const modelIntegrationPool = new Pool({ connectionString: databaseUrl });
const schemaName = "tenant_ampersand_dev";

describe("model publication database integration", () => {
  afterAll(async () => {
    await modelIntegrationPool.end();
  });

  test("publishes a candidate model", async () => {
    const client = await modelIntegrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const candidate = await client.query<{ id: string }>(
        `
          SELECT id
          FROM model_versions
          WHERE status = 'candidate'
            AND is_active = true
          LIMIT 1
        `,
      );

      const modelVersionId = candidate.rows[0]?.id;

      if (!modelVersionId) {
        throw new Error("No candidate model version is available");
      }

      const user = await client.query<{ id: string }>(
        `
          SELECT id
          FROM users
          WHERE is_active = true
          LIMIT 1
        `,
      );

      const publisherId = user.rows[0]?.id;

      if (!publisherId) {
        throw new Error("No active tenant user is available");
      }

      const result = await publishCandidateModel(
        client,
        schemaName,
        modelVersionId,
        publisherId,
      );

      expect(result.ok).toBe(true);

      if (result.ok) {
        expect(result.body.status).toBe("published");
        expect(result.body.id).toBe(modelVersionId);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("retires a model and blocks its prediction tool", async () => {
    const client = await modelIntegrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const model = await client.query<{
        id: string;
        tool_name: string;
      }>(
        `
          SELECT mv.id, td.tool_name
          FROM model_versions mv
          INNER JOIN tool_definitions td
            ON td.model_version_id = mv.id
          WHERE mv.status = 'published'
            AND mv.is_active = true
            AND td.is_active = true
          LIMIT 1
        `,
      );
      const selectedModel = model.rows[0];

      if (!selectedModel) {
        throw new Error("No published model with an active tool is available");
      }

      const user = await client.query<{ id: string }>(
        `
          SELECT id
          FROM users
          WHERE is_active = true
          LIMIT 1
        `,
      );
      const retiredBy = user.rows[0]?.id;

      if (!retiredBy) {
        throw new Error("No active tenant user is available");
      }

      const retirement = await retirePublishedModel(
        client,
        schemaName,
        selectedModel.id,
        retiredBy,
      );

      expect(retirement.ok).toBe(true);
      if (!retirement.ok) {
        throw new Error("Expected model retirement to succeed");
      }

      expect(retirement.body).toMatchObject({
        id: selectedModel.id,
        status: "retired",
      });

      const registry = await getModelRegistry(client, schemaName);
      const retiredModel = registry.models.find(
        (entry) => entry.id === selectedModel.id,
      );

      expect(retiredModel).toMatchObject({
        status: "retired",
        retiredBy,
      });
      expect(retiredModel?.retiredAt).not.toBeNull();

      const discoverableTools = await listPublishedToolDefinitions(
        client,
        schemaName,
      );
      expect(
        discoverableTools.some(
          (tool) => tool.modelVersionId === selectedModel.id,
        ),
      ).toBe(false);

      const prediction = await validateToolPrediction(
        client,
        schemaName,
        retiredBy,
        {
          toolName: selectedModel.tool_name,
          inputs: {},
        },
      );
      expect(prediction).toEqual({
        kind: "error",
        status: 404,
        body: {
          error: {
            code: "TOOL_NOT_AVAILABLE",
            message: "The requested prediction tool is not available",
          },
        },
      });

      const repeatedRetirement = await retirePublishedModel(
        client,
        schemaName,
        selectedModel.id,
        retiredBy,
      );
      expect(repeatedRetirement).toEqual({
        ok: false,
        status: 409,
        body: {
          error: {
            code: "INVALID_MODEL_TRANSITION",
            message: "Model version cannot transition from 'retired' to retired",
            currentStatus: "retired",
          },
        },
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("rejects missing and non-published models", async () => {
    const client = await modelIntegrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const user = await client.query<{ id: string }>(
        `
          SELECT id
          FROM users
          WHERE is_active = true
          LIMIT 1
        `,
      );
      const retiredBy = user.rows[0]?.id;

      if (!retiredBy) {
        throw new Error("No active tenant user is available");
      }

      const missingResult = await retirePublishedModel(
        client,
        schemaName,
        "00000000-0000-4000-8000-000000000000",
        retiredBy,
      );
      expect(missingResult).toEqual({
        ok: false,
        status: 404,
        body: {
          error: {
            code: "MODEL_VERSION_NOT_FOUND",
            message: "Model version was not found",
            currentStatus: null,
          },
        },
      });

      const candidate = await client.query<{ id: string }>(
        `
          SELECT id
          FROM model_versions
          WHERE status = 'candidate'
            AND is_active = true
          LIMIT 1
        `,
      );
      const candidateId = candidate.rows[0]?.id;

      if (!candidateId) {
        throw new Error("No candidate model version is available");
      }

      const candidateResult = await retirePublishedModel(
        client,
        schemaName,
        candidateId,
        retiredBy,
      );
      expect(candidateResult).toEqual({
        ok: false,
        status: 409,
        body: {
          error: {
            code: "INVALID_MODEL_TRANSITION",
            message: "Model version cannot transition from 'candidate' to retired",
            currentStatus: "candidate",
          },
        },
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
