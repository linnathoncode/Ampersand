import type {
  PredictionInputValue,
  PredictionRejectedResponse,
  PredictionRequest,
} from "@ampersand/contracts";
import { ToolInputSchemaDto } from "@ampersand/contracts";
import { Value } from "@sinclair/typebox/value";
import type { PoolClient } from "pg";

import { findPublishedToolByName } from "../tool-definitions/repository";
import { storeRejectedInferenceCall } from "./repository";
import { validatePredictionInputs } from "./validate-inputs";

export type PredictionValidationError = {
  error: {
    code: "TOOL_NOT_AVAILABLE" | "INVALID_TOOL_SCHEMA";
    message: string;
  };
};

export type ValidateToolPredictionResult =
  | {
      kind: "accepted";
      toolDefinitionId: string;
      modelVersionId: string;
      modelVersion: number;
      inputs: Record<string, PredictionInputValue>;
    }
  | {
      kind: "rejected";
      body: PredictionRejectedResponse;
    }
  | {
      kind: "error";
      status: 404 | 500;
      body: PredictionValidationError;
    };

type PredictionValidationDependencies = {
  findTool: typeof findPublishedToolByName;
  storeRejection: typeof storeRejectedInferenceCall;
};

const defaultDependencies: PredictionValidationDependencies = {
  findTool: findPublishedToolByName,
  storeRejection: storeRejectedInferenceCall,
};

export async function validateToolPrediction(
  client: PoolClient,
  schemaName: string,
  createdBy: string,
  request: PredictionRequest,
  dependencies: PredictionValidationDependencies = defaultDependencies,
): Promise<ValidateToolPredictionResult> {
  const startedAt = performance.now();
  const tool = await dependencies.findTool(
    client,
    schemaName,
    request.toolName,
  );

  if (!tool) {
    return {
      kind: "error",
      status: 404,
      body: {
        error: {
          code: "TOOL_NOT_AVAILABLE",
          message: "The requested prediction tool is not available",
        },
      },
    };
  }

  const inputSchema = tool.inputSchema;

  if (!Value.Check(ToolInputSchemaDto, inputSchema)) {
    return invalidToolSchema();
  }

  const hasInvalidRequiredField = inputSchema.required.some(
    (name) => !(name in inputSchema.properties),
  );

  if (hasInvalidRequiredField) {
    return invalidToolSchema();
  }

  const validation = validatePredictionInputs(
    inputSchema,
    request.inputs,
  );

  if (!validation.ok) {
    await dependencies.storeRejection(client, schemaName, {
      toolDefinitionId: tool.id,
      modelVersionId: tool.modelVersionId,
      createdBy,
      conversationId: request.conversationId ?? null,
      inputs: request.inputs,
      rejection: validation.rejection,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });

    return {
      kind: "rejected",
      body: {
        outcome: "rejected",
        prediction: null,
        uncertainty: null,
        modelVersionId: tool.modelVersionId,
        modelVersion: tool.modelVersion,
        warnings: [],
        rejection: validation.rejection,
      },
    };
  }

  return {
    kind: "accepted",
    toolDefinitionId: tool.id,
    modelVersionId: tool.modelVersionId,
    modelVersion: tool.modelVersion,
    inputs: validation.inputs,
  };
}

function invalidToolSchema(): ValidateToolPredictionResult {
  return {
    kind: "error",
    status: 500,
    body: {
      error: {
        code: "INVALID_TOOL_SCHEMA",
        message: "The stored tool input schema is invalid",
      },
    },
  };
}
