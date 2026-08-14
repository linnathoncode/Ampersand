import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import type { PoolClient } from "pg";

import {
  createModelArtifactsForSchema,
  createModelVersionsForSchema,
} from "../drizzle/schema";

export type StoredModelArtifact = {
  modelVersionId: string;
  storageUri: string;
  contentSha256: string;
  sizeBytes: number;
  producerWorkerId: string;
};

export async function findVerifiableModelArtifact(
  client: PoolClient,
  schemaName: string,
  modelVersionId: string,
): Promise<StoredModelArtifact | null> {
  const tenantSchema = pgSchema(schemaName);
  const modelArtifacts = createModelArtifactsForSchema(tenantSchema);
  const modelVersions = createModelVersionsForSchema(tenantSchema);
  const database = drizzle(client);

  const rows = await database
    .select({
      modelVersionId: modelArtifacts.modelVersionId,
      storageUri: modelArtifacts.storageUri,
      contentSha256: modelArtifacts.contentSha256,
      sizeBytes: modelArtifacts.sizeBytes,
      producerWorkerId: modelArtifacts.producerWorkerId,
    })
    .from(modelArtifacts)
    .innerJoin(
      modelVersions,
      eq(modelArtifacts.modelVersionId, modelVersions.id),
    )
    .where(
      and(
        eq(modelArtifacts.modelVersionId, modelVersionId),
        eq(modelArtifacts.isActive, true),
        eq(modelVersions.isActive, true),
        eq(modelVersions.status, "published"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
