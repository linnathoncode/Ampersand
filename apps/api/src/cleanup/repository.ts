import type { PoolClient } from "pg";

export interface AbandonedSnapshot {
  id: string;
  storageUri: string;
}

export interface UnreferencedCandidate {
  artifactId: string;
  modelVersionId: string;
  storageUri: string;
}

export async function findAbandonedSnapshots(
  client: PoolClient,
  cutoff: Date,
): Promise<AbandonedSnapshot[]> {
  const result = await client.query<{ id: string; storage_uri: string }>(
    `SELECT ds.id, ds.storage_uri
     FROM dataset_snapshots ds
     LEFT JOIN training_jobs tj ON tj.dataset_snapshot_id = ds.id
     WHERE tj.id IS NULL AND ds.created_at < $1`,
    [cutoff],
  );
  return result.rows.map((r) => ({ id: r.id, storageUri: r.storage_uri }));
}

export async function findUnreferencedCandidateArtifacts(
  client: PoolClient,
  cutoff: Date,
): Promise<UnreferencedCandidate[]> {
  const result = await client.query<{
    artifact_id: string;
    model_version_id: string;
    storage_uri: string;
  }>(
    `SELECT ma.id AS artifact_id, ma.model_version_id, ma.storage_uri
     FROM model_artifacts ma
     JOIN model_versions mv ON mv.id = ma.model_version_id
     WHERE mv.status = 'candidate' AND mv.created_at < $1`,
    [cutoff],
  );
  return result.rows.map((r) => ({
    artifactId: r.artifact_id,
    modelVersionId: r.model_version_id,
    storageUri: r.storage_uri,
  }));
}

export async function countProtectedArtifacts(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM model_artifacts ma
     JOIN model_versions mv ON mv.id = ma.model_version_id
     WHERE mv.status IN ('published', 'retired')`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function deleteAbandonedSnapshots(
  client: PoolClient,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const result = await client.query<{ storage_uri: string }>(
    `DELETE FROM dataset_snapshots ds
     WHERE ds.id = ANY($1::uuid[])
       AND NOT EXISTS (SELECT 1 FROM training_jobs tj WHERE tj.dataset_snapshot_id = ds.id)
     RETURNING storage_uri`,
    [ids],
  );
  return result.rows.map((r) => r.storage_uri);
}

export async function deleteUnreferencedCandidates(
  client: PoolClient,
  modelVersionIds: string[],
): Promise<string[]> {
  if (modelVersionIds.length === 0) return [];
  await client.query(
    `SELECT id FROM model_versions WHERE id = ANY($1::uuid[]) AND status = 'candidate' FOR UPDATE`,
    [modelVersionIds],
  );
  const result = await client.query<{ storage_uri: string }>(
    `DELETE FROM model_artifacts
     WHERE model_version_id = ANY($1::uuid[])
       AND model_version_id IN (SELECT id FROM model_versions WHERE id = ANY($1::uuid[]) AND status = 'candidate')
     RETURNING storage_uri`,
    [modelVersionIds],
  );
  await client.query(
    `DELETE FROM model_versions WHERE id = ANY($1::uuid[]) AND status = 'candidate'`,
    [modelVersionIds],
  );
  return result.rows.map((r) => r.storage_uri);
}
