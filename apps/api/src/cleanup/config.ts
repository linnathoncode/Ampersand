import { resolvePositiveInt } from "../utils/env";

export const DEFAULT_STALE_TEMP_AGE_HOURS = 24;
export const DEFAULT_ABANDONED_SNAPSHOT_AGE_HOURS = 72;
export const DEFAULT_UNREFERENCED_CANDIDATE_AGE_HOURS = 168;

const HOURS_TO_MS = 3_600_000;

export function resolveStaleTempAgeMs(): number {
  return (
    resolvePositiveInt(process.env.CLEANUP_STALE_TEMP_AGE_HOURS, DEFAULT_STALE_TEMP_AGE_HOURS) * HOURS_TO_MS
  );
}

export function resolveAbandonedSnapshotAgeMs(): number {
  return (
    resolvePositiveInt(
      process.env.CLEANUP_ABANDONED_SNAPSHOT_AGE_HOURS,
      DEFAULT_ABANDONED_SNAPSHOT_AGE_HOURS,
    ) * HOURS_TO_MS
  );
}

export function resolveUnreferencedCandidateAgeMs(): number {
  return (
    resolvePositiveInt(
      process.env.CLEANUP_UNREFERENCED_CANDIDATE_AGE_HOURS,
      DEFAULT_UNREFERENCED_CANDIDATE_AGE_HOURS,
    ) * HOURS_TO_MS
  );
}

export function resolveTenantStorageQuotaBytes(): number | null {
  const raw = process.env.TENANT_STORAGE_QUOTA_BYTES;
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}
