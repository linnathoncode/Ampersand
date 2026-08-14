import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type {
  PredictionInputValue,
  ToolInputProperty,
  ToolInputSchema,
} from "@ampersand/contracts";
import { ToolInputSchemaDto } from "@ampersand/contracts";
import { Value } from "@sinclair/typebox/value";
import pg from "pg";

import { createFilesystemArtifactReader } from "../../../artifact-verification/filesystem-reader";
import { verifyStoredModelArtifact } from "../../../artifact-verification/service";
import { completeToolPrediction } from "../../complete-prediction";
import { listOnnxFeatures } from "../../onnx/repository";
import { runOnnxInference } from "../../onnx/run-inference";
import { validateToolPrediction } from "../../service";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const integrationPool = new Pool({ connectionString: databaseUrl });
const schemaName = "tenant_ampersand_dev";

type PublishedToolRow = {
  id: string;
  tool_name: string;
  input_schema: unknown;
};

type RejectionAuditRow = {
  outcome: string;
  prediction: string | null;
  uncertainty: string | null;
  rejection_code: string | null;
};

type PublishedOnnxModelRow = {
  model_version_id: string;
  version_number: number;
  artifact_id: string;
  tool_id: string;
  tool_name: string;
};

type OnnxFeatureRow = {
  id: string;
  column_name: string;
  position: number;
};

function createValidValue(property: ToolInputProperty): PredictionInputValue {
  if (property.enum) {
    return property.enum[0]!;
  }

  switch (property.type) {
    case "boolean":
      return false;
    case "string":
      return "integration-test";
    case "integer":
      return Math.ceil(property.minimum ?? property.maximum ?? 0);
    case "number":
      return property.minimum ?? property.maximum ?? 0;
  }
}

function createOutOfRangeInputs(schema: ToolInputSchema): {
  inputs: Record<string, PredictionInputValue>;
  rejectedField: string;
} {
  const inputs = Object.fromEntries(
    schema.required.map((name) => [
      name,
      createValidValue(schema.properties[name]!),
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

  const [rejectedField, property] = boundedFeature;
  inputs[rejectedField] =
    property.maximum !== undefined
      ? property.maximum + 1
      : property.minimum! - 1;

  return { inputs, rejectedField };
}

describe("prediction validation database integration", () => {
  afterAll(async () => {
    await integrationPool.end();
  });

  test("rejects out-of-range input and stores an audit record", async () => {
    const client = await integrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const toolResult = await client.query<PublishedToolRow>(`
        SELECT td.id, td.tool_name, td.input_schema
        FROM tool_definitions td
        INNER JOIN model_versions mv ON mv.id = td.model_version_id
        WHERE td.is_active = true
          AND mv.is_active = true
          AND mv.status = 'published'
          AND EXISTS (
            SELECT 1
            FROM jsonb_each(td.input_schema->'properties') AS property
            WHERE property.value->>'type' IN ('number', 'integer')
              AND (
                property.value ? 'minimum'
                OR property.value ? 'maximum'
              )
          )
        LIMIT 1
      `);

      const tool = toolResult.rows[0];

      if (!tool || !Value.Check(ToolInputSchemaDto, tool.input_schema)) {
        throw new Error("No published tool with a valid bounded schema exists");
      }

      const userResult = await client.query<{ id: string }>(`
        SELECT id
        FROM users
        WHERE is_active = true
        LIMIT 1
      `);
      const userId = userResult.rows[0]?.id;

      if (!userId) {
        throw new Error("No active tenant user exists");
      }

      const { inputs, rejectedField } = createOutOfRangeInputs(
        tool.input_schema,
      );

      const beforeResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) FROM inference_calls WHERE tool_definition_id = $1`,
        [tool.id],
      );

      const result = await validateToolPrediction(
        client,
        schemaName,
        userId,
        {
          toolName: tool.tool_name,
          conversationId: "day-26-integration",
          inputs,
        },
      );

      expect(result.kind).toBe("rejected");

      if (result.kind !== "rejected") {
        throw new Error("Expected an out-of-range rejection");
      }

      expect(result.body.rejection.code).toBe("OUT_OF_RANGE");

      const afterResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) FROM inference_calls WHERE tool_definition_id = $1`,
        [tool.id],
      );
      const auditResult = await client.query<RejectionAuditRow>(
        `
          SELECT outcome, prediction, uncertainty, rejection_code
          FROM inference_calls
          WHERE tool_definition_id = $1
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [tool.id],
      );
      const audit = auditResult.rows[0];
      const auditStored =
        Number(afterResult.rows[0]?.count) ===
        Number(beforeResult.rows[0]?.count) + 1;

      if (!audit) {
        throw new Error("Rejected inference audit was not found");
      }

      expect(auditStored).toBe(true);
      expect(audit).toEqual({
        outcome: "rejected",
        prediction: null,
        uncertainty: null,
        rejection_code: "OUT_OF_RANGE",
      });

      console.log(
        "Prediction rejection integration:",
        JSON.stringify(
          {
            toolName: tool.tool_name,
            rejectedField,
            rejectionCode: result.body.rejection.code,
            rejectionMessage: result.body.rejection.fields[0]?.message,
            auditOutcome: audit.outcome,
            prediction: audit.prediction,
            auditStored,
          },
          null,
          2,
        ),
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("runs a verified ONNX model and stores its prediction", async () => {
    const artifactDirectory = await mkdtemp(
      join(tmpdir(), "ampersand-onnx-integration-"),
    );
    const client = await integrationPool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO ${schemaName}`);

      const modelResult = await client.query<PublishedOnnxModelRow>(`
        SELECT
          mv.id AS model_version_id,
          mv.version_number,
          ma.id AS artifact_id,
          td.id AS tool_id,
          td.tool_name
        FROM model_versions mv
        INNER JOIN model_artifacts ma ON ma.model_version_id = mv.id
        INNER JOIN tool_definitions td ON td.model_version_id = mv.id
        WHERE mv.status = 'published'
          AND mv.is_active = true
          AND ma.is_active = true
          AND td.is_active = true
          AND (
            SELECT COUNT(*)
            FROM model_features mf
            WHERE mf.model_version_id = mv.id
              AND mf.is_active = true
          ) >= 2
        LIMIT 1
      `);
      const model = modelResult.rows[0];

      if (!model) {
        throw new Error(
          "No published model with an artifact, tool, and two features exists",
        );
      }

      const featureResult = await client.query<OnnxFeatureRow>(
        `
          SELECT id, column_name, position
          FROM model_features
          WHERE model_version_id = $1
            AND is_active = true
          ORDER BY position
          LIMIT 2
        `,
        [model.model_version_id],
      );
      const [firstFeature, secondFeature] = featureResult.rows;

      if (
        !firstFeature ||
        !secondFeature ||
        firstFeature.position !== 0 ||
        secondFeature.position !== 1
      ) {
        throw new Error("The published model does not have positions 0 and 1");
      }

      const userResult = await client.query<{ id: string }>(`
        SELECT id FROM users WHERE is_active = true LIMIT 1
      `);
      const userId = userResult.rows[0]?.id;

      if (!userId) {
        throw new Error("No active tenant user exists");
      }

      await client.query(
        `
          UPDATE model_features
          SET is_active = false
          WHERE model_version_id = $1
            AND id NOT IN ($2, $3)
        `,
        [model.model_version_id, firstFeature.id, secondFeature.id],
      );
      await client.query(
        `
          UPDATE model_features
          SET data_type = CASE WHEN id = $1 THEN 'number' ELSE 'integer' END,
              is_required = true,
              allowed_values = NULL
          WHERE id IN ($1, $2)
        `,
        [firstFeature.id, secondFeature.id],
      );

      const inputSchema = {
        type: "object",
        properties: {
          [firstFeature.column_name]: {
            type: "number",
            description: "First regression input",
          },
          [secondFeature.column_name]: {
            type: "integer",
            description: "Second regression input",
          },
        },
        required: [firstFeature.column_name, secondFeature.column_name],
        additionalProperties: false,
      };

      await client.query(
        `UPDATE tool_definitions SET input_schema = $1 WHERE id = $2`,
        [JSON.stringify(inputSchema), model.tool_id],
      );

      const fixtureBytes = await readFile(
        new URL("../fixtures/linear-regression.onnx", import.meta.url),
      );
      const filename = `${randomUUID()}.onnx`;
      const sha256 = createHash("sha256")
        .update(fixtureBytes)
        .digest("hex");
      await writeFile(join(artifactDirectory, filename), fixtureBytes);

      await client.query(
        `
          UPDATE model_artifacts
          SET storage_uri = $1,
              content_sha256 = $2,
              size_bytes = $3,
              producer_worker_id = $4
          WHERE id = $5
        `,
        [
          filename,
          sha256,
          fixtureBytes.byteLength,
          "onnx-integration-worker",
          model.artifact_id,
        ],
      );

      const request = {
        toolName: model.tool_name,
        conversationId: "day-29-onnx-integration",
        inputs: {
          [firstFeature.column_name]: 4,
          [secondFeature.column_name]: 6,
        },
      };
      const validation = await validateToolPrediction(
        client,
        schemaName,
        userId,
        request,
      );

      if (validation.kind !== "accepted") {
        throw new Error("Integration inputs were not accepted");
      }

      const verification = await verifyStoredModelArtifact(
        client,
        schemaName,
        model.model_version_id,
        new Set(["onnx-integration-worker"]),
        createFilesystemArtifactReader(artifactDirectory),
      );

      if (!verification.ok) {
        throw new Error(`Artifact verification failed: ${verification.reason}`);
      }

      const features = await listOnnxFeatures(
        client,
        schemaName,
        model.model_version_id,
      );
      const inference = await runOnnxInference({
        artifactBytes: verification.bytes,
        features,
        inputs: validation.inputs,
      });
      const response = await completeToolPrediction(
        client,
        schemaName,
        userId,
        {
          accepted: validation,
          request,
          inference,
          latencyMs: 1,
        },
      );

      const auditResult = await client.query<{
        outcome: string;
        prediction: string | null;
        uncertainty: string | null;
      }>(
        `
          SELECT outcome, prediction, uncertainty
          FROM inference_calls
          WHERE tool_definition_id = $1
            AND conversation_id = $2
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [model.tool_id, request.conversationId],
      );
      const audit = auditResult.rows[0];

      if (!audit) {
        throw new Error("ONNX prediction audit was not found");
      }

      expect(features.map((feature) => feature.name)).toEqual([
        firstFeature.column_name,
        secondFeature.column_name,
      ]);
      expect(response.prediction).toBe(31);
      expect(response.uncertainty).toBeNull();
      expect(audit).toEqual({
        outcome: "prediction",
        prediction: "31",
        uncertainty: null,
      });

      console.log(
        "ONNX prediction integration:",
        JSON.stringify(
          {
            toolName: model.tool_name,
            modelVersion: model.version_number,
            artifactVerified: true,
            inputFeatureSnippet: features.map((feature) => ({
              name: feature.name,
              position: feature.position,
              dataType: feature.dataType,
              value: request.inputs[feature.name],
            })),
            onnxResult: inference,
            auditOutcome: audit.outcome,
            auditStored: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });
});
