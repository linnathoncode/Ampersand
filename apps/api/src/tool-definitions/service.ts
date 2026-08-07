import type {
  GeneratedToolDefinition,
  ToolGenerationError,
} from "@ampersand/contracts";

import type { PoolClient } from "pg";
import { generateToolDefinition } from "./generate-tool-schema";
import {
  findToolGenerationModel,
  listStoredModelFeatures,
  toModelFeatureMetadata,
} from "./repository";
import { defaultMaxListeners } from "events";

const TOOL_GENERATOR_VERSION = "1.0.0";

export type GenerateModelToolResult =
  | {
      ok: true;
      body: GeneratedToolDefinition;
    }
  | {
      ok: false;
      status: 404 | 409 | 422;
      body: ToolGenerationError;
    };

export function createToolName(
  targetColumn: string,
  modelVersionId: string,
): string {
  const normalizedTarget = targetColumn
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const target = normalizedTarget || "prediction";
  const modelSuffix = modelVersionId.slice(0, 8);

  return `predict_${target}_${modelSuffix}`;
}

type ToolGenerationDependencies = {
  findModel: typeof findToolGenerationModel;
  listFeatures: typeof listStoredModelFeatures;
};

const defaultDependencies: ToolGenerationDependencies = {
  findModel: findToolGenerationModel,
  listFeatures: listStoredModelFeatures,
};

export async function generateModelToolDefinition(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
  dependencies: ToolGenerationDependencies = defaultDependencies,
): Promise<GenerateModelToolResult> {
  const model = await dependencies.findModel(
    client,
    schemaName,
    modelVersionId,
  );

  if (!model) {
    return {
      ok: false,
      status: 404,
      body: {
        error: {
          code: "MODEL_VERSION_NOT_FOUND",
          message: `Model version with id: ${modelVersionId} was not found`,
        },
      },
    };
  }

  if (model.status !== "published") {
    return {
      ok: false,
      status: 409,
      body: {
        error: {
          code: "MODEL_VERSION_NOT_PUBLISHED",
          message: "Only published models can generate tools",
        },
      },
    };
  }

  if (model.artifactId === null) {
    return {
      ok: false,
      status: 422,
      body: {
        error: {
          code: "MODEL_ARTIFACT_NOT_FOUND",
          message: "Published model does not have an active artifact",
        },
      },
    };
  }

  const storedFeatures = await dependencies.listFeatures(
    client,
    schemaName,
    modelVersionId,
  );

  if (storedFeatures.length === 0) {
    return {
      ok: false,
      status: 422,
      body: {
        error: {
          code: "MODEL_FEATURES_NOT_FOUND",
          message: "Model does not have active feature metadata",
        },
      },
    };
  }

  try {
    const features = storedFeatures.map(toModelFeatureMetadata);

    return {
      ok: true,
      body: generateToolDefinition({
        modelVersionId: model.id,
        toolName: createToolName(model.targetColumn, model.id),
        description:
          `Predict ${model.targetColumn} using ` +
          `${model.datasetName} model version ${model.versionNumber}.`,
        generatorVersion: TOOL_GENERATOR_VERSION,
        features,
      }),
    };
  } catch {
    return {
      ok: false,
      status: 422,
      body: {
        error: {
          code: "INVALID_MODEL_FEATURE_METADATA",
          message: "Model feature metadata is invalid",
        },
      },
    };
  }
}
