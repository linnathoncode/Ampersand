import type {
  ModelVersionStatus,
  ModelVersionSummary,
  PublishModelVersionResponse,
  RetireModelVersionResponse,
} from "@ampersand/contracts";

import { desc, eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";

import {
  createDatasetDefinitionsForSchema,
  createModelVersionsForSchema,
} from "../drizzle/schema";

export async function listModelVersions(
  client: PoolClient,
  schemaName: string,
): Promise<ModelVersionSummary[]> {
  const tenantSchema = pgSchema(schemaName);
  const modelVersions = createModelVersionsForSchema(tenantSchema);
  const datasetDefinitions = createDatasetDefinitionsForSchema(tenantSchema);
  const database = drizzle(client);

  const rows = await database
    .select({
      id: modelVersions.id,
      datasetDefinitionId: modelVersions.datasetDefinitionId,
      trainingJobId: modelVersions.trainingJobId,
      versionNumber: modelVersions.versionNumber,
      status: modelVersions.status,
      parentVersionId: modelVersions.parentVersionId,
      publishedAt: modelVersions.publishedAt,
      publishedBy: modelVersions.publishedBy,
      retiredAt: modelVersions.retiredAt,
      retiredBy: modelVersions.retiredBy,
      createdAt: modelVersions.createdAt,
      datasetName: datasetDefinitions.name,
      targetColumn: datasetDefinitions.targetColumn,
    })
    .from(modelVersions)
    .innerJoin(
      datasetDefinitions,
      eq(modelVersions.datasetDefinitionId, datasetDefinitions.id),
    )
    .where(
      and(
        eq(modelVersions.isActive, true),
        eq(datasetDefinitions.isActive, true),
      ),
    )
    .orderBy(desc(modelVersions.createdAt));

  return rows.map((row) => ({
    ...row,
    status: parseModelVersionStatus(row.status),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

function parseModelVersionStatus(status: string): ModelVersionStatus {
  if (
    status === "candidate" ||
    status === "published" ||
    status === "retired"
  ) {
    return status;
  }

  throw new Error(`Unknown model-version status: ${status}`);
}

export async function publishModelVersion(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
  publishedBy: string,
): Promise<PublishModelVersionResponse | null> {
  const tenantSchema = pgSchema(schemaName);
  const modelVersions = createModelVersionsForSchema(tenantSchema);
  const database = drizzle(client);
  const publishedAt = new Date();

  const rows = await database
    .update(modelVersions)
    .set({
      status: "published",
      publishedAt,
      publishedBy,
      updatedAt: publishedAt,
      updatedBy: publishedBy,
    })
    .where(
      and(
        eq(modelVersions.id, modelVersionId),
        eq(modelVersions.status, "candidate"),
        eq(modelVersions.isActive, true),
      ),
    )
    .returning({
      id: modelVersions.id,
      versionNumber: modelVersions.versionNumber,
      publishedAt: modelVersions.publishedAt,
    });

  const publishedModel = rows[0];
  if (!publishedModel?.publishedAt) {
    return null;
  }

  return {
    id: publishedModel.id,
    versionNumber: publishedModel.versionNumber,
    status: "published",
    publishedAt: publishedModel.publishedAt.toISOString(),
  };
}

export async function retireModelVersion(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
  retiredBy: string,
): Promise<RetireModelVersionResponse | null> {
  const tenantSchema = pgSchema(schemaName);
  const modelVersions = createModelVersionsForSchema(tenantSchema);
  const database = drizzle(client);
  const retiredAt = new Date();

  const rows = await database
    .update(modelVersions)
    .set({
      status: "retired",
      retiredAt,
      retiredBy,
      updatedAt: retiredAt,
      updatedBy: retiredBy,
    })
    .where(
      and(
        eq(modelVersions.id, modelVersionId),
        eq(modelVersions.status, "published"),
        eq(modelVersions.isActive, true),
      ),
    )
    .returning({
      id: modelVersions.id,
      versionNumber: modelVersions.versionNumber,
      retiredAt: modelVersions.retiredAt,
    });

  const retiredModel = rows[0];

  if (!retiredModel?.retiredAt) {
    return null;
  }

  return {
    id: retiredModel.id,
    versionNumber: retiredModel.versionNumber,
    status: "retired",
    retiredAt: retiredModel.retiredAt.toISOString(),
  };
}

export async function findModelVersionStatus(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
): Promise<ModelVersionStatus | null> {
  const tenantSchema = pgSchema(schemaName);
  const modelVersions = createModelVersionsForSchema(tenantSchema);
  const database = drizzle(client);

  const rows = await database
    .select({
      status: modelVersions.status,
    })
    .from(modelVersions)
    .where(
      and(
        eq(modelVersions.id, modelVersionId),
        eq(modelVersions.isActive, true),
      ),
    )
    .limit(1);

  const model = rows[0];
  if (!model) return null;

  return parseModelVersionStatus(model.status);
}
