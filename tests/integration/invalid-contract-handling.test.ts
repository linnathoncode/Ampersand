import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Value } from "@sinclair/typebox/value";
import {
  PredictionRequestDto,
  type PredictionRequest,
} from "@ampersand/contracts";
import type pg from "pg";

import { beginScoped, createPool, resolveTenantSchema } from "./support/db";
import { registerFormats } from "./support/contracts";
import {
  publishAndGenerateTool,
  runPrediction,
  runTrainingFlow,
} from "./support/flows";

registerFormats();

describe("invalid-contract handling", () => {
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

  it("rejects malformed and out-of-range prediction requests before any inference call", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, schemaName);

      const training = await runTrainingFlow(client, {
        outcome: "succeeded",
        schemaName,
      });
      const modelVersionId = training.modelVersionId;
      if (!modelVersionId) throw new Error("expected a model version");

      const tool = await publishAndGenerateTool(client, {
        modelVersionId,
        versionNumber: 1,
      });

      const malformedRequest = {
        toolName: tool.toolName,
        inputs: { temperature: { nested: 1 }, occupancy: 12 },
      };
      expect(Value.Check(PredictionRequestDto, malformedRequest)).toBe(false);

      await expect(
        runPrediction(client, {
          toolDefinitionId: tool.toolDefinitionId,
          modelVersionId,
          versionNumber: 1,
          toolDefinition: tool.toolDefinition,
          request: malformedRequest,
        }),
      ).rejects.toThrow(/Invalid prediction request/);

      const outOfRangeRequest: PredictionRequest = {
        toolName: tool.toolName,
        inputs: { temperature: 200, occupancy: 12 },
      };
      expect(Value.Check(PredictionRequestDto, outOfRangeRequest)).toBe(true);

      await expect(
        runPrediction(client, {
          toolDefinitionId: tool.toolDefinitionId,
          modelVersionId,
          versionNumber: 1,
          toolDefinition: tool.toolDefinition,
          request: outOfRangeRequest,
        }),
      ).rejects.toThrow(/temperature must be at most 50/);

      const inferenceCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM inference_calls WHERE tool_definition_id = $1`,
        [tool.toolDefinitionId],
      );
      expect(inferenceCount.rows[0]?.count).toBe("0");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
