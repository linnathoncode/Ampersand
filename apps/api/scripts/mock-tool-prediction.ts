import pg from "pg";

import { FormatRegistry, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  GeneratedToolDefinitionDto,
  PredictionRequestDto,
  PredictionResponseDto,
  PredictionSuccessResponseDto,
  type GeneratedToolDefinition,
  type PredictionRequest,
  type PredictionSuccessResponse,
} from "@ampersand/contracts";

const { Pool } = pg;

FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
);

type ModelRecord = {
  id: string;
  version_number: number;
};

export async function runMockToolPrediction(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const subdomain = process.env.DEV_TENANT_SUBDOMAIN ?? "ampersand-dev";
  // Creates a pool of reusable PostgreSQL connections; local connections use TCP.
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const schemaName = await findTenantSchema(pool, subdomain);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL search_path TO "${schemaName}"`);

      const model = await selectModelWithoutTool(client);
      await publishModel(client, model.id);

      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const toolDefinition = createToolDefinition(model.id, suffix);
      assertContract(
        GeneratedToolDefinitionDto,
        toolDefinition,
        "generated tool definition",
      );

      const toolDefinitionId = await storeToolDefinition(client, toolDefinition);
      console.log(`Tool available for LLM discovery: ${toolDefinition.toolName}`);

      const predictionRequest = createPredictionRequest(toolDefinition.toolName, suffix);
      assertContract(PredictionRequestDto, predictionRequest, "prediction request");
      validateGeneratedInputs(predictionRequest.inputs);

      const predictionResponse = createPredictionResponse(model);
      assertContract(
        PredictionSuccessResponseDto,
        predictionResponse,
        "successful prediction response",
      );
      assertContract(PredictionResponseDto, predictionResponse, "prediction response union");

      const inferenceCallId = await recordInference(
        client,
        toolDefinitionId,
        model,
        predictionRequest,
        predictionResponse,
      );

      await client.query("COMMIT");
      console.log("Mock tool-to-prediction flow completed");
      console.table({
        schemaName,
        modelVersionId: model.id,
        toolDefinitionId,
        inferenceCallId,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await runMockToolPrediction();
}

async function selectModelWithoutTool(client: pg.PoolClient): Promise<ModelRecord> {
  const modelResult = await client.query<ModelRecord>(
    `SELECT mv.id, mv.version_number
     FROM model_versions mv
     LEFT JOIN tool_definitions td ON td.model_version_id = mv.id
     WHERE mv.status IN ('candidate', 'published')
       AND td.id IS NULL
     ORDER BY mv.created_at DESC
     LIMIT 1`,
  );
  return requiredRow(modelResult, "trained model");
}

async function publishModel(client: pg.PoolClient, modelVersionId: string): Promise<void> {
  await client.query(
    `UPDATE model_versions
     SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now()
     WHERE id = $1`,
    [modelVersionId],
  );
}

function createToolDefinition(
  modelVersionId: string,
  suffix: string,
): GeneratedToolDefinition {
  return {
    modelVersionId,
    toolName: `predict_energy_usage_${suffix}`,
    description: "Predict building energy usage from temperature and occupancy.",
    generatorVersion: "mock-1.0.0",
    inputSchema: {
      type: "object",
      properties: {
        temperature: {
          type: "number",
          description: "Outside temperature in celsius.",
          minimum: -20,
          maximum: 50,
        },
        occupancy: {
          type: "integer",
          description: "Number of occupants.",
          minimum: 0,
          maximum: 500,
        },
      },
      required: ["temperature", "occupancy"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        outcome: { enum: ["prediction", "rejected"] },
        prediction: { type: ["number", "null"] },
        uncertainty: { type: ["number", "null"] },
        modelVersion: { type: "integer" },
        warnings: { type: "array", items: { type: "string" } },
        rejection: { type: ["object", "null"] },
      },
      required: [
        "outcome",
        "prediction",
        "uncertainty",
        "modelVersion",
        "warnings",
        "rejection",
      ],
      additionalProperties: false,
    },
  };
}

async function storeToolDefinition(
  client: pg.PoolClient,
  toolDefinition: GeneratedToolDefinition,
): Promise<string> {
  const storedTool = await client.query<{ id: string }>(
    `INSERT INTO tool_definitions
      (model_version_id, tool_name, description, input_schema, output_schema,
       generator_version, schema_sha256, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING id`,
    [
      toolDefinition.modelVersionId,
      toolDefinition.toolName,
      toolDefinition.description,
      JSON.stringify(toolDefinition.inputSchema),
      JSON.stringify(toolDefinition.outputSchema),
      toolDefinition.generatorVersion,
      randomDigest(),
    ],
  );
  return requiredRow(storedTool, "tool definition").id;
}

function createPredictionRequest(
  toolName: string,
  suffix: string,
): PredictionRequest {
  return {
    toolName,
    conversationId: `mock-conversation-${suffix}`,
    inputs: { temperature: 24, occupancy: 12 },
  };
}

function createPredictionResponse(model: ModelRecord): PredictionSuccessResponse {
  return {
    outcome: "prediction",
    prediction: 48.4,
    uncertainty: 1.3,
    modelVersionId: model.id,
    modelVersion: model.version_number,
    warnings: [],
    rejection: null,
  };
}

async function recordInference(
  client: pg.PoolClient,
  toolDefinitionId: string,
  model: ModelRecord,
  predictionRequest: PredictionRequest,
  predictionResponse: PredictionSuccessResponse,
): Promise<string> {
  const inference = await client.query<{ id: string }>(
    `INSERT INTO inference_calls
      (tool_definition_id, model_version_id, conversation_id, input_payload, outcome,
       prediction, uncertainty, warnings, latency_ms)
     VALUES ($1, $2, $3, $4, 'prediction', $5, $6, $7, 8)
     RETURNING id`,
    [
      toolDefinitionId,
      model.id,
      predictionRequest.conversationId,
      JSON.stringify(predictionRequest.inputs),
      predictionResponse.prediction,
      predictionResponse.uncertainty,
      JSON.stringify(predictionResponse.warnings),
    ],
  );
  return requiredRow(inference, "inference call").id;
}

async function findTenantSchema(
  pool: pg.Pool,
  subdomain: string,
): Promise<string> {
  const tenantResult = await pool.query<{ schema_name: string }>(
    "SELECT schema_name FROM main.tenants WHERE subdomain = $1 AND status = 'active'",
    [subdomain],
  );
  const schemaName = tenantResult.rows[0]?.schema_name;

  if (!schemaName) throw new Error(`Active tenant '${subdomain}' was not found`);
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Unsafe PostgreSQL schema identifier: ${schemaName}`);
  }

  return schemaName;
}

function requiredRow<T extends pg.QueryResultRow>(
  result: pg.QueryResult<T>,
  recordName: string,
): T {
  const row = result.rows[0];
  if (!row) throw new Error(`Could not find or create ${recordName}`);
  return row;
}

function assertContract(schema: TSchema, value: unknown, label: string): void {
  if (Value.Check(schema, value)) {
    console.log(`PASS contract validation: ${label}`);
    return;
  }

  const errors = [...Value.Errors(schema, value)]
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid ${label}: ${errors}`);
}

function validateGeneratedInputs(inputs: Record<string, unknown>): void {
  const expected = ["temperature", "occupancy"];
  const unknown = Object.keys(inputs).filter((name) => !expected.includes(name));
  if (unknown.length > 0) throw new Error(`Unknown tool inputs: ${unknown.join(", ")}`);

  const temperature = inputs.temperature;
  const occupancy = inputs.occupancy;
  if (typeof temperature !== "number" || temperature < -20 || temperature > 50) {
    throw new Error("temperature must be a number from -20 through 50");
  }
  if (!Number.isInteger(occupancy) || (occupancy as number) < 0 || (occupancy as number) > 500) {
    throw new Error("occupancy must be an integer from 0 through 500");
  }

  console.log("PASS generated tool input validation");
}

// Creates a random 32-byte hexadecimal value as placeholder tool-schema metadata.
function randomDigest(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
