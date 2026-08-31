import { randomBytes } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CleanupAlreadyRunningError, runCleanup } from "../../apps/api/src/cleanup/index";
import { beginScoped, createPool, resolveTenantSchema } from "./support/db";

const TTL_HOURS = 1;
function digest(): string { return randomBytes(32).toString("hex"); }
const storageRoot = resolve(process.env.ARTIFACT_STORAGE_PATH ?? "./artifacts");
let pool: ReturnType<typeof createPool>;
let tenantSchema: string;

async function insertDatasetDefinition(client: any, name: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO dataset_definitions (name, source_schema, source_table, target_column) VALUES ($1,$2,'energy_readings','energy_usage') RETURNING id`,
    [name, tenantSchema],
  );
  return r.rows[0]!.id;
}
async function insertSnapshot(client: any, defId: string, uri: string, createdAt: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO dataset_snapshots (dataset_definition_id, storage_uri, storage_format, content_sha256, row_count, schema_summary, frozen_at, created_at) VALUES ($1,$2,'parquet',$3,1,'{}',now(),${createdAt}) RETURNING id`,
    [defId, uri, digest()],
  );
  return r.rows[0]!.id;
}
async function insertTrainingJob(client: any, snapId: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO training_jobs (dataset_snapshot_id, fingerprint, status, training_config, progress_percent, queued_at, max_runtime_seconds) VALUES ($1,$2,'queued','{}',0,now(),60) RETURNING id`,
    [snapId, `fp-${digest().slice(0,16)}`],
  );
  return r.rows[0]!.id;
}
async function insertModel(client: any, defId: string, jobId: string, n: number, status: string, uri: string, createdAt: string): Promise<string> {
  const r = await client.query<{ id: string }>(
    `INSERT INTO model_versions (dataset_definition_id, training_job_id, version_number, status, metrics, baseline_metrics, created_at) VALUES ($1,$2,$3,$4,'{}','{}',${createdAt}) RETURNING id`,
    [defId, jobId, n, status],
  );
  const vid = r.rows[0]!.id;
  await client.query(
    `INSERT INTO model_artifacts (model_version_id, storage_uri, format, content_sha256, size_bytes, producer_worker_id, produced_at, created_at) VALUES ($1,$2,'onnx',$3,1024,'mock-worker',now(),${createdAt})`,
    [vid, uri, digest()],
  );
  return vid;
}
async function writeArtifact(uri: string): Promise<void> {
  const abs = resolve(storageRoot, uri);
  await mkdir(resolve(abs, ".."), { recursive: true });
  await writeFile(abs, "artifact-bytes");
}
async function fileExists(uri: string): Promise<boolean> {
  try { await stat(resolve(storageRoot, uri)); return true; } catch { return false; }
}
function withRetentionOverrides() { process.env.CLEANUP_STALE_TEMP_AGE_HOURS=String(TTL_HOURS); process.env.CLEANUP_ABANDONED_SNAPSHOT_AGE_HOURS=String(TTL_HOURS); process.env.CLEANUP_UNREFERENCED_CANDIDATE_AGE_HOURS=String(TTL_HOURS); }

describe("cleanup lean integration", () => {
  beforeAll(async () => {
    pool = createPool();
    tenantSchema = await resolveTenantSchema(pool, process.env.DEV_TENANT_SUBDOMAIN ?? "ampersand-dev");
    await mkdir(storageRoot, { recursive: true });
  });
  afterAll(async () => { await pool?.end(); });
  afterEach(() => {
    delete process.env.CLEANUP_STALE_TEMP_AGE_HOURS;
    delete process.env.CLEANUP_ABANDONED_SNAPSHOT_AGE_HOURS;
    delete process.env.CLEANUP_UNREFERENCED_CANDIDATE_AGE_HOURS;
  });

  it("protected published artifact not deleted", async () => {
    const client = await pool.connect();
    let defId="", snapId="", jobId="", versionId="", uri="";
    try {
      await beginScoped(client, tenantSchema);
      defId = await insertDatasetDefinition(client, `cleanup-prot-${digest().slice(0,8)}`);
      const snapUri = `${digest()}.parquet`;
      snapId = await insertSnapshot(client, defId, snapUri, "now()");
      await writeArtifact(snapUri);
      jobId = await insertTrainingJob(client, snapId);
      uri = `models/${defId}/v1/${jobId}.onnx`;
      versionId = await insertModel(client, defId, jobId, 1, "published", uri, "now() - interval '2 hours'");
      await client.query(`UPDATE model_versions SET published_at=now() WHERE id=$1`,[versionId]);
      await writeArtifact(uri);
      await client.query("COMMIT");

      withRetentionOverrides();
      const result = await runCleanup({ schemaName: tenantSchema, dryRun: false });
      expect(result.protectedCount).toBeGreaterThanOrEqual(1);
      expect(result.errors).toEqual([]);
      expect(await fileExists(uri)).toBe(true);
      await client.query(`SET search_path TO "${tenantSchema}"`);
      const row = await client.query(`SELECT id FROM model_versions WHERE id=$1`,[versionId]);
      expect(row.rows).toHaveLength(1);

      await client.query(`SET search_path TO "${tenantSchema}"`);
      await client.query(`DELETE FROM model_artifacts WHERE model_version_id=$1`,[versionId]);
      await client.query(`DELETE FROM model_versions WHERE id=$1`,[versionId]);
      await client.query(`DELETE FROM training_jobs WHERE id=$1`,[jobId]);
      await client.query(`DELETE FROM dataset_snapshots WHERE id=$1`,[snapId]);
      await client.query(`DELETE FROM dataset_definitions WHERE id=$1`,[defId]);
      await rm(resolve(storageRoot, uri),{force:true});
      await rm(resolve(storageRoot, snapUri),{force:true});
    } finally { await client.query("ROLLBACK").catch(()=>{}); client.release(); }
  });

  it("abandoned snapshot deleted", async () => {
    const client = await pool.connect();
    let defId="", snapId="", uri="";
    try {
      await beginScoped(client, tenantSchema);
      defId = await insertDatasetDefinition(client, `cleanup-abandon-${digest().slice(0,8)}`);
      uri = `${digest()}.parquet`;
      snapId = await insertSnapshot(client, defId, uri, "now() - interval '2 hours'");
      await writeArtifact(uri);
      await client.query("COMMIT");

      withRetentionOverrides();
      const result = await runCleanup({ schemaName: tenantSchema, dryRun: false });
      expect(result.candidates.abandonedSnapshots).toBeGreaterThanOrEqual(1);
      expect(result.deleted.abandonedSnapshots).toBeGreaterThanOrEqual(1);
      expect(result.bytesReclaimed).toBeGreaterThan(0);
      expect(await fileExists(uri)).toBe(false);
      await client.query(`SET search_path TO "${tenantSchema}"`);
      const row = await client.query(`SELECT id FROM dataset_snapshots WHERE id=$1`,[snapId]);
      expect(row.rows).toHaveLength(0);

      await client.query(`SET search_path TO "${tenantSchema}"`);
      await client.query(`DELETE FROM dataset_definitions WHERE id=$1`,[defId]).catch(()=>{});
    } finally { await client.query("ROLLBACK").catch(()=>{}); client.release(); }
  });

  it("concurrent serializes", async () => {
    const client = await pool.connect();
    let defId="", snapId="", uri="", jobId="", candUri="", candVid="";
    try {
      await beginScoped(client, tenantSchema);
      defId = await insertDatasetDefinition(client, `cleanup-conc-${digest().slice(0,8)}`);
      uri = `${digest()}.parquet`;
      snapId = await insertSnapshot(client, defId, uri, "now() - interval '2 hours'");
      await writeArtifact(uri);
      const refSnapUri = `${digest()}.parquet`;
      const refSnapId = await insertSnapshot(client, defId, refSnapUri, "now()");
      await writeArtifact(refSnapUri);
      jobId = await insertTrainingJob(client, refSnapId);
      candUri = `models/${defId}/v1/${jobId}.onnx`;
      candVid = await insertModel(client, defId, jobId, 1, "candidate", candUri, "now() - interval '2 hours'");
      await writeArtifact(candUri);
      await client.query("COMMIT");

      withRetentionOverrides();
      const settled = await Promise.allSettled([
        runCleanup({ schemaName: tenantSchema, dryRun: false }),
        runCleanup({ schemaName: tenantSchema, dryRun: false }),
      ]);
      const successes = settled.filter((r)=>r.status==="fulfilled") as PromiseFulfilledResult<any>[];
      const failures = settled.filter((r)=>r.status==="rejected") as PromiseRejectedResult[];
      expect(successes.length).toBeGreaterThanOrEqual(1);
      if (failures.length>0) for (const f of failures) expect(f.reason).toBeInstanceOf(CleanupAlreadyRunningError);
      let totalAbandoned=0, totalCandidates=0;
      for (const s of successes){ totalAbandoned+=s.value.deleted.abandonedSnapshots; totalCandidates+=s.value.deleted.unreferencedCandidates; }
      expect(totalAbandoned).toBe(1);
      expect(totalCandidates).toBe(1);

      await client.query(`SET search_path TO "${tenantSchema}"`);
      await client.query(`DELETE FROM model_artifacts WHERE model_version_id=$1`,[candVid]).catch(()=>{});
      await client.query(`DELETE FROM model_versions WHERE id=$1`,[candVid]).catch(()=>{});
      await client.query(`DELETE FROM training_jobs WHERE id=$1`,[jobId]).catch(()=>{});
      await client.query(`DELETE FROM dataset_snapshots WHERE id=ANY($1::uuid[])`,[[snapId, refSnapId]]).catch(()=>{});
      await client.query(`DELETE FROM dataset_definitions WHERE id=$1`,[defId]).catch(()=>{});
      for (const u of [uri, refSnapUri, candUri]) await rm(resolve(storageRoot,u),{force:true});
    } finally { await client.query("ROLLBACK").catch(()=>{}); client.release(); }
  });

  it("dryRun zero deletes", async () => {
    const client = await pool.connect();
    let defId="", snapId="", uri="";
    try {
      await beginScoped(client, tenantSchema);
      defId = await insertDatasetDefinition(client, `cleanup-dry-${digest().slice(0,8)}`);
      uri = `${digest()}.parquet`;
      snapId = await insertSnapshot(client, defId, uri, "now() - interval '2 hours'");
      await writeArtifact(uri);
      await client.query("COMMIT");

      withRetentionOverrides();
      const result = await runCleanup({ schemaName: tenantSchema, dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.candidates.abandonedSnapshots).toBeGreaterThanOrEqual(1);
      expect(result.deleted.abandonedSnapshots).toBe(0);
      expect(result.deleted.unreferencedCandidates).toBe(0);
      expect(result.deleted.staleTempFiles).toBe(0);
      expect(result.bytesReclaimed).toBe(0);
      expect(await fileExists(uri)).toBe(true);

      withRetentionOverrides();
      await runCleanup({ schemaName: tenantSchema, dryRun: false });
      await client.query(`SET search_path TO "${tenantSchema}"`);
      await client.query(`DELETE FROM dataset_definitions WHERE id=$1`,[defId]).catch(()=>{});
    } finally { await client.query("ROLLBACK").catch(()=>{}); client.release(); }
  });
});
