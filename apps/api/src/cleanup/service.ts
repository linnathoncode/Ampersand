import { rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { PoolClient } from "pg";

import type { CleanupError, CleanupResult } from "@ampersand/contracts";

import { withTenantTransaction } from "../database/tenant-transaction";
import { resolveStorageRoot } from "../utils/env";
import {
  resolveAbandonedSnapshotAgeMs,
  resolveStaleTempAgeMs,
  resolveUnreferencedCandidateAgeMs,
} from "./config";
import { findStaleTempFiles } from "./filesystem";
import {
  countProtectedArtifacts,
  deleteAbandonedSnapshots,
  deleteUnreferencedCandidates,
  findAbandonedSnapshots,
  findUnreferencedCandidateArtifacts,
} from "./repository";
import type { RunCleanupOptions } from "./types";

const ADVISORY_KEY = "cleanup";

export class CleanupAlreadyRunningError extends Error {
  constructor(schemaName: string) {
    super(`A cleanup run for tenant '${schemaName}' is already in progress`);
    this.name = "CleanupAlreadyRunningError";
  }
}

export async function runCleanup(options: RunCleanupOptions): Promise<CleanupResult> {
  const storageRoot = resolveStorageRoot(options.storageRoot);
  const start = performance.now();

  const staleTempFiles = await findStaleTempFiles(storageRoot, resolveStaleTempAgeMs());

  const tx = await withTenantTransaction(options.schemaName, (client) =>
    runCleanupInTransaction(client, options.schemaName, options.dryRun ?? false),
  );

  const errors: CleanupError[] = [];
  let deletedStaleTemp = 0;
  let bytesStaleTemp = 0;
  let deletedSnapshots = 0;
  let bytesSnapshots = 0;
  let deletedCandidates = 0;
  let bytesCandidates = 0;

  if (!tx.dryRun) {
    for (const file of staleTempFiles) {
      try {
        assertWithinRoot(storageRoot, file.absolutePath);
        await rm(file.absolutePath, { force: true });
        deletedStaleTemp += 1;
        bytesStaleTemp += file.sizeBytes;
      } catch (error) {
        errors.push({ class: "stale_temp_file", id: null, message: errorMessage(error) });
      }
    }
    for (const uri of tx.abandonedUris) {
      const reclaimed = await deleteArtifactFile(storageRoot, uri, "abandoned_snapshot", errors);
      if (reclaimed >= 0) {
        deletedSnapshots += 1;
        bytesSnapshots += reclaimed;
      }
    }
    for (const uri of tx.candidateUris) {
      const reclaimed = await deleteArtifactFile(storageRoot, uri, "unreferenced_candidate", errors);
      if (reclaimed >= 0) {
        deletedCandidates += 1;
        bytesCandidates += reclaimed;
      }
    }
  }

  const bytesReclaimed = bytesStaleTemp + bytesSnapshots + bytesCandidates;
  const result: CleanupResult = {
    dryRun: tx.dryRun,
    scanned: staleTempFiles.length + tx.abandonedCount + tx.candidateCount,
    candidates: {
      staleTempFiles: staleTempFiles.length,
      abandonedSnapshots: tx.abandonedCount,
      unreferencedCandidates: tx.candidateCount,
    },
    deleted: {
      staleTempFiles: deletedStaleTemp,
      abandonedSnapshots: deletedSnapshots,
      unreferencedCandidates: deletedCandidates,
    },
    bytesReclaimed,
    protectedCount: tx.protectedCount,
    errors,
    durationMs: Math.round(performance.now() - start),
  };
  return result;
}

async function runCleanupInTransaction(
  client: PoolClient,
  schemaName: string,
  dryRun: boolean,
): Promise<{
  dryRun: boolean;
  abandonedUris: string[];
  candidateUris: string[];
  protectedCount: number;
  abandonedCount: number;
  candidateCount: number;
}> {
  const locked = await acquireAdvisoryLock(client, schemaName, dryRun);
  if (!locked && !dryRun) throw new CleanupAlreadyRunningError(schemaName);

  const now = Date.now();
  const abandoned = await findAbandonedSnapshots(client, new Date(now - resolveAbandonedSnapshotAgeMs()));
  const candidates = await findUnreferencedCandidateArtifacts(
    client,
    new Date(now - resolveUnreferencedCandidateAgeMs()),
  );
  const protectedCount = await countProtectedArtifacts(client);

  let abandonedUris: string[] = [];
  let candidateUris: string[] = [];
  if (!dryRun) {
    abandonedUris = await deleteAbandonedSnapshots(
      client,
      abandoned.map((s) => s.id),
    );
    candidateUris = await deleteUnreferencedCandidates(
      client,
      candidates.map((c) => c.modelVersionId),
    );
  }

  return {
    dryRun,
    abandonedUris,
    candidateUris,
    protectedCount,
    abandonedCount: abandoned.length,
    candidateCount: candidates.length,
  };
}

async function acquireAdvisoryLock(
  client: PoolClient,
  schemaName: string,
  dryRun: boolean,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, hashtext($2)::bigint)) AS locked`,
      [ADVISORY_KEY, schemaName],
    );
    if (r.rows[0]?.locked) return true;
    if (attempt < 2) await new Promise((res) => setTimeout(res, attempt === 0 ? 100 : 200));
  }
  return dryRun;
}

async function deleteArtifactFile(
  storageRoot: string,
  storageUri: string,
  errorClass: CleanupError["class"],
  errors: CleanupError[],
): Promise<number> {
  try {
    const absolutePath = resolve(storageRoot, storageUri);
    assertWithinRoot(storageRoot, absolutePath);
    const size = await stat(absolutePath)
      .then((s) => s.size)
      .catch(() => 0);
    await rm(absolutePath, { force: true });
    return size;
  } catch (error) {
    errors.push({ class: errorClass, id: null, message: errorMessage(error) });
    return -1;
  }
}

function assertWithinRoot(storageRoot: string, absolutePath: string): void {
  const rel = relative(storageRoot, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing to delete a path outside the storage root: ${absolutePath}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
