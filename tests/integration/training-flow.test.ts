import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Value } from "@sinclair/typebox/value";
import {
  TrainingWorkerInputDto,
  TrainingWorkerResultDto,
} from "@ampersand/contracts";
import type pg from "pg";

import { beginScoped, createPool, resolveTenantSchema } from "./support/db";
import { registerFormats } from "./support/contracts";
import { runTrainingFlow, WORKER_ID } from "./support/flows";

registerFormats();

describe("training flow integration", () => {
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

  it("queues, claims, and completes a job with a candidate model", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, schemaName);

      const result = await runTrainingFlow(client, {
        outcome: "succeeded",
        schemaName,
      });

      expect(Value.Check(TrainingWorkerInputDto, result.workerInput)).toBe(true);
      expect(Value.Check(TrainingWorkerResultDto, result.workerResult)).toBe(true);

      const job = await client.query<{
        status: string;
        progress_percent: number;
        claimed_by: string;
        finished_at: Date | null;
      }>(
        `SELECT status, progress_percent, claimed_by, finished_at
         FROM training_jobs WHERE id = $1`,
        [result.trainingJobId],
      );
      expect(job.rows[0]).toMatchObject({
        status: "succeeded",
        progress_percent: 100,
        claimed_by: WORKER_ID,
      });
      expect(job.rows[0]?.finished_at).not.toBeNull();

      const model = await client.query<{
        id: string;
        version_number: number;
        status: string;
      }>(
        `SELECT id, version_number, status
         FROM model_versions WHERE training_job_id = $1`,
        [result.trainingJobId],
      );
      expect(model.rows[0]).toMatchObject({ version_number: 1, status: "candidate" });
      expect(model.rows[0]?.id).toBe(result.modelVersionId);

      const modelVersionId = result.modelVersionId;
      if (!modelVersionId) throw new Error("expected a model version");
      if (result.workerResult.result.status !== "succeeded") {
        throw new Error("expected successful training");
      }
      const success = result.workerResult.result;

      const artifact = await client.query<{
        storage_uri: string;
        format: string;
        content_sha256: string;
        size_bytes: string;
        producer_worker_id: string;
      }>(
        `SELECT storage_uri, format, content_sha256, size_bytes, producer_worker_id
         FROM model_artifacts WHERE model_version_id = $1`,
        [modelVersionId],
      );
      expect(artifact.rows[0]).toMatchObject({
        format: "onnx",
        content_sha256: success.artifact.contentSha256,
        producer_worker_id: result.workerResult.workerId,
      });
      expect(Number(artifact.rows[0]?.size_bytes)).toBe(success.artifact.sizeBytes);
      expect(artifact.rows[0]?.storage_uri).toBe(success.artifact.storageUri);

      const features = await client.query<{
        column_name: string;
        position: number;
        data_type: string;
        valid_min: string;
        valid_max: string;
      }>(
        `SELECT column_name, position, data_type, valid_min, valid_max
         FROM model_features WHERE model_version_id = $1 ORDER BY position`,
        [modelVersionId],
      );
      expect(features.rows).toHaveLength(2);
      expect(features.rows[0]).toMatchObject({
        column_name: "temperature",
        position: 0,
        data_type: "number",
      });
      expect(Number(features.rows[0]?.valid_min)).toBe(-20);
      expect(Number(features.rows[0]?.valid_max)).toBe(50);
      expect(features.rows[1]).toMatchObject({
        column_name: "occupancy",
        position: 1,
        data_type: "integer",
      });
      expect(Number(features.rows[1]?.valid_min)).toBe(0);
      expect(Number(features.rows[1]?.valid_max)).toBe(500);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  it("records a structured worker failure without creating a model", async () => {
    const client = await pool.connect();
    try {
      await beginScoped(client, schemaName);

      const result = await runTrainingFlow(client, {
        outcome: "failed",
        schemaName,
      });

      expect(result.modelVersionId).toBeNull();
      expect(result.workerResult.result.status).toBe("failed");
      expect(Value.Check(TrainingWorkerResultDto, result.workerResult)).toBe(true);

      const job = await client.query<{
        status: string;
        progress_percent: number;
        error_code: string | null;
        error_message: string | null;
      }>(
        `SELECT status, progress_percent, error_code, error_message
         FROM training_jobs WHERE id = $1`,
        [result.trainingJobId],
      );
      expect(job.rows[0]).toMatchObject({
        status: "failed",
        error_code: "MOCK_TRAINING_REJECTED",
        error_message: "The mock worker rejected the training job.",
      });
      expect(job.rows[0]?.progress_percent).not.toBe(100);

      const modelCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM model_versions WHERE training_job_id = $1`,
        [result.trainingJobId],
      );
      expect(modelCount.rows[0]?.count).toBe("0");

      const artifactCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM model_artifacts ma
         JOIN model_versions mv ON mv.id = ma.model_version_id
         WHERE mv.training_job_id = $1`,
        [result.trainingJobId],
      );
      expect(artifactCount.rows[0]?.count).toBe("0");

      const featureCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM model_features mf
         JOIN model_versions mv ON mv.id = mf.model_version_id
         WHERE mv.training_job_id = $1`,
        [result.trainingJobId],
      );
      expect(featureCount.rows[0]?.count).toBe("0");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
