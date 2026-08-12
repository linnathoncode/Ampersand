import { afterAll, describe, expect, test } from "bun:test";
import type {
  PredictionInputValue,
  ToolInputProperty,
  ToolInputSchema,
} from "@ampersand/contracts";
import { ToolInputSchemaDto } from "@ampersand/contracts";
import { Value } from "@sinclair/typebox/value";
import pg from "pg";

import { validateToolPrediction } from "./service";

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
});
