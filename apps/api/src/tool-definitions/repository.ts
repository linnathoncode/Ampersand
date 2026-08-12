import type { GeneratedToolDefinition } from "@ampersand/contracts";

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";

import type { ModelFeatureMetadata } from "./generate-tool-schema";
import {
  createDatasetDefinitionsForSchema,
  createModelArtifactsForSchema,
  createModelFeaturesForSchema,
  createModelVersionsForSchema,
  createToolDefinitionsForSchema,
} from "../drizzle/schema";

export type StoredModelFeature = {
  columnName: string;
  description: string;
  unit: string | null;
  dataType: string;
  isRequired: boolean;
  validMin: string | null;
  validMax: string | null;
  allowedValues: unknown;
  position: number;
};

export type StoredToolGenerationModel = {
  id: string;
  status: string;
  versionNumber: number;
  datasetName: string;
  targetColumn: string;
  artifactId: string | null;
};

export type StoredToolDefinition = {
  id: string;
  modelVersionId: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  generatorVersion: string;
  schemaSha256: string;
  generatedAt: Date;
};

export type StoredPredictionTool = {
  id: string;
  modelVersionId: string;
  modelVersion: number;
  inputSchema: unknown;
};

export async function listStoredModelFeatures(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
): Promise<StoredModelFeature[]> {
  const tenantSchema = pgSchema(schemaName);
  const modelFeatures = createModelFeaturesForSchema(tenantSchema);
  const database = drizzle(client);

  return database
    .select({
      columnName: modelFeatures.columnName,
      position: modelFeatures.position,
      dataType: modelFeatures.dataType,
      description: modelFeatures.description,
      unit: modelFeatures.unit,
      isRequired: modelFeatures.isRequired,
      validMin: modelFeatures.validMin,
      validMax: modelFeatures.validMax,
      allowedValues: modelFeatures.allowedValues,
    })
    .from(modelFeatures)
    .where(
      and(
        eq(modelFeatures.modelVersionId, modelVersionId),
        eq(modelFeatures.isActive, true),
      ),
    )
    .orderBy(asc(modelFeatures.position));
}

export function toModelFeatureMetadata(
  feature: StoredModelFeature,
): ModelFeatureMetadata {
  const dataType = parseModelFeatureDataType(feature.dataType);
  const allowedValues = parseAllowedValues(feature.allowedValues);

  return {
    columnName: feature.columnName,
    dataType,
    description: feature.description,
    unit: feature.unit,
    isRequired: feature.isRequired,
    validMin: parseNullableNumber(feature.validMin, "validMin"),
    validMax: parseNullableNumber(feature.validMax, "validMax"),
    allowedValues,
  };
}

function parseModelFeatureDataType(
  value: string,
): ModelFeatureMetadata["dataType"] {
  if (
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "category"
  ) {
    return value;
  }

  throw new Error(`Unsupported model feature type: ${value}`);
}

function parseAllowedValues(value: unknown): Array<string | number> | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" || typeof item === "number")
  ) {
    throw new Error("Invalid model feature allowed values");
  }

  return value;
}

function parseNullableNumber(
  value: string | null,
  fieldName: string,
): number | null {
  if (value === null) return null;

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  return parsed;
}

export async function findToolGenerationModel(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
): Promise<StoredToolGenerationModel | null> {
  const tenantSchema = pgSchema(schemaName);
  const modelVersions = createModelVersionsForSchema(tenantSchema);
  const datasetDefinitions = createDatasetDefinitionsForSchema(tenantSchema);
  const modelArtifacts = createModelArtifactsForSchema(tenantSchema);
  const database = drizzle(client);

  const rows = await database
    .select({
      id: modelVersions.id,
      status: modelVersions.status,
      versionNumber: modelVersions.versionNumber,
      datasetName: datasetDefinitions.name,
      targetColumn: datasetDefinitions.targetColumn,
      artifactId: modelArtifacts.id,
    })
    .from(modelVersions)
    .innerJoin(
      datasetDefinitions,
      eq(modelVersions.datasetDefinitionId, datasetDefinitions.id),
    )
    .leftJoin(
      modelArtifacts,
      and(
        eq(modelArtifacts.modelVersionId, modelVersions.id),
        eq(modelArtifacts.isActive, true),
      ),
    )
    .where(
      and(
        eq(modelVersions.id, modelVersionId),
        eq(modelVersions.isActive, true),
        eq(datasetDefinitions.isActive, true),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function storeToolDefinition(
  client: PoolClient,
  schemaName: string,
  definition: GeneratedToolDefinition,
  schemaSha256: string,
  createdBy: string,
): Promise<StoredToolDefinition> {
  const tenantSchema = pgSchema(schemaName);
  const toolDefinitions = createToolDefinitionsForSchema(tenantSchema);
  const database = drizzle(client);
  const generatedAt = new Date();

  const rows = await database
    .insert(toolDefinitions)
    .values({
      modelVersionId: definition.modelVersionId,
      toolName: definition.toolName,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      generatorVersion: definition.generatorVersion,
      schemaSha256,
      generatedAt,
      createdBy,
    })
    .returning({
      id: toolDefinitions.id,
      modelVersionId: toolDefinitions.modelVersionId,
      toolName: toolDefinitions.toolName,
      description: toolDefinitions.description,
      inputSchema: toolDefinitions.inputSchema,
      outputSchema: toolDefinitions.outputSchema,
      generatorVersion: toolDefinitions.generatorVersion,
      schemaSha256: toolDefinitions.schemaSha256,
      generatedAt: toolDefinitions.generatedAt,
    });

  const storedDefinition = rows[0];

  if (!storedDefinition) {
    throw new Error("Tool definition could not be stored");
  }

  return storedDefinition;
}

export async function findStoredToolDefinition(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
): Promise<StoredToolDefinition | null> {
  const tenantSchema = pgSchema(schemaName);
  const toolDefinitions = createToolDefinitionsForSchema(tenantSchema);
  const database = drizzle(client);

  const rows = await database
    .select({
      id: toolDefinitions.id,
      modelVersionId: toolDefinitions.modelVersionId,
      toolName: toolDefinitions.toolName,
      description: toolDefinitions.description,
      inputSchema: toolDefinitions.inputSchema,
      outputSchema: toolDefinitions.outputSchema,
      generatorVersion: toolDefinitions.generatorVersion,
      schemaSha256: toolDefinitions.schemaSha256,
      generatedAt: toolDefinitions.generatedAt,
    })
    .from(toolDefinitions)
    .where(
      and(
        eq(toolDefinitions.isActive, true),
        eq(toolDefinitions.modelVersionId, modelVersionId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function listPublishedToolDefinitions(
  client: PoolClient,
  schemaName: string,
): Promise<StoredToolDefinition[]> {
  const tenantSchema = pgSchema(schemaName);
  const toolDefinitions = createToolDefinitionsForSchema(tenantSchema);
  const modelVersions = createModelVersionsForSchema(tenantSchema);
  const database = drizzle(client);

  return database
    .select({
      id: toolDefinitions.id,
      modelVersionId: toolDefinitions.modelVersionId,
      toolName: toolDefinitions.toolName,
      description: toolDefinitions.description,
      inputSchema: toolDefinitions.inputSchema,
      outputSchema: toolDefinitions.outputSchema,
      generatorVersion: toolDefinitions.generatorVersion,
      schemaSha256: toolDefinitions.schemaSha256,
      generatedAt: toolDefinitions.generatedAt,
    })
    .from(toolDefinitions)
    .innerJoin(
      modelVersions,
      eq(toolDefinitions.modelVersionId, modelVersions.id),
    )
    .where(
      and(
        eq(toolDefinitions.isActive, true),
        eq(modelVersions.isActive, true),
        eq(modelVersions.status, "published"),
      ),
    )
    .orderBy(asc(toolDefinitions.toolName));
}

export async function findPublishedToolByName(
  client: PoolClient,
  schemaName: string,
  toolName: string,
): Promise<StoredPredictionTool | null> {
  const tenantSchema = pgSchema(schemaName);
  const toolDefinitions = createToolDefinitionsForSchema(tenantSchema);
  const modelVersions = createModelVersionsForSchema(tenantSchema);
  const database = drizzle(client);

  const rows = await database
    .select({
      id: toolDefinitions.id,
      modelVersionId: toolDefinitions.modelVersionId,
      modelVersion: modelVersions.versionNumber,
      inputSchema: toolDefinitions.inputSchema,
    })
    .from(toolDefinitions)
    .innerJoin(
      modelVersions,
      eq(toolDefinitions.modelVersionId, modelVersions.id),
    )
    .where(
      and(
        eq(toolDefinitions.toolName, toolName),
        eq(toolDefinitions.isActive, true),
        eq(modelVersions.isActive, true),
        eq(modelVersions.status, "published"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
