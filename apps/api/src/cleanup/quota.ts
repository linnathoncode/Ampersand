import { stat } from "node:fs/promises";
import type { PoolClient } from "pg";

import { resolveTenantStorageQuotaBytes } from "./config";

export class TenantStorageQuotaExceededError extends Error {
  readonly usageBytes: number;
  readonly quotaBytes: number;
  readonly incomingBytes: number;

  constructor(usageBytes: number, quotaBytes: number, incomingBytes: number) {
    super("Tenant storage quota exceeded");
    this.name = "TenantStorageQuotaExceededError";
    this.usageBytes = usageBytes;
    this.quotaBytes = quotaBytes;
    this.incomingBytes = incomingBytes;
  }
}

export async function getTenantStorageUsage(
  client: PoolClient,
  resolveStorageUri: (uri: string) => string,
): Promise<bigint> {
  const artifactResult = await client.query<{ total: string | null }>(
    "SELECT SUM(size_bytes)::text AS total FROM model_artifacts",
  );
  let total = BigInt(artifactResult.rows[0]?.total ?? "0");
  const snapshotResult = await client.query<{ storage_uri: string }>(
    "SELECT storage_uri FROM dataset_snapshots",
  );
  const rows = snapshotResult.rows;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const sizes = await Promise.all(
      batch.map(async (row) => {
        try {
          return BigInt((await stat(resolveStorageUri(row.storage_uri))).size);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return BigInt(0);
          throw error;
        }
      }),
    );
    for (const s of sizes) total += s;
  }
  return total;
}

export async function enforceTenantStorageQuota(
  client: PoolClient,
  schemaName: string,
  resolveStorageUri: (uri: string) => string,
  incomingBytes: number,
): Promise<void> {
  const quota = resolveTenantStorageQuotaBytes();
  if (quota === null) return;
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, hashtext($2)::bigint))",
    ["quota", schemaName],
  );
  const usage = await getTenantStorageUsage(client, resolveStorageUri);
  const quotaBig = BigInt(quota);
  const incomingBig = BigInt(incomingBytes);
  if (usage + incomingBig > quotaBig) {
    throw new TenantStorageQuotaExceededError(Number(usage), quota, incomingBytes);
  }
}
