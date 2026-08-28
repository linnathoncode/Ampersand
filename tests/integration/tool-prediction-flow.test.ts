import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Value } from "@sinclair/typebox/value";
import {
  GeneratedToolDefinitionDto,
  PredictionRequestDto,
  PredictionResponseDto,
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

describe("tool-to-prediction flow integration", () => {
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

  it("publishes a candidate model, generates a tool, and records a valid prediction", async () => {
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
      expect(Value.Check(GeneratedToolDefinitionDto, tool.toolDefinition)).toBe(true);

      const model = await client.query<{ status: string }>(
        "SELECT status FROM model_versions WHERE id = $1",
        [modelVersionId],
      );
      expect(model.rows[0]?.status).toBe("published");

      const toolLink = await client.query<{ model_version_id: string }>(
        "SELECT model_version_id FROM tool_definitions WHERE id = $1",
        [tool.toolDefinitionId],
      );
      expect(toolLink.rows[0]?.model_version_id).toBe(modelVersionId);

      const request: PredictionRequest = {
        toolName: tool.toolName,
        conversationId: "integration-conversation",
        inputs: { temperature: 24, occupancy: 12 },
      };
      expect(Value.Check(PredictionRequestDto, request)).toBe(true);

      const prediction = await runPrediction(client, {
        toolDefinitionId: tool.toolDefinitionId,
        modelVersionId,
        versionNumber: 1,
        toolDefinition: tool.toolDefinition,
        request,
      });
      expect(Value.Check(PredictionResponseDto, prediction.predictionResponse)).toBe(
        true,
      );

      const inference = await client.query<{
        outcome: string;
        prediction: string;
        uncertainty: string;
        model_version_id: string;
        input_payload: unknown;
        latency_ms: number;
      }>(
        `SELECT outcome, prediction, uncertainty, model_version_id, input_payload, latency_ms
         FROM inference_calls WHERE id = $1`,
        [prediction.inferenceCallId],
      );
      const row = inference.rows[0];
      expect(row).toBeDefined();
      expect(row?.outcome).toBe("prediction");
      expect(Number(row?.prediction)).toBe(48.4);
      expect(Number(row?.uncertainty)).toBe(1.3);
      expect(row?.model_version_id).toBe(modelVersionId);
      expect(row?.input_payload).toEqual({ temperature: 24, occupancy: 12 });
      expect(row?.latency_ms).toBe(8);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
