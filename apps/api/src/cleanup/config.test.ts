import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_ABANDONED_SNAPSHOT_AGE_HOURS,
  DEFAULT_STALE_TEMP_AGE_HOURS,
  DEFAULT_UNREFERENCED_CANDIDATE_AGE_HOURS,
  resolveAbandonedSnapshotAgeMs,
  resolveStaleTempAgeMs,
  resolveTenantStorageQuotaBytes,
  resolveUnreferencedCandidateAgeMs,
} from "./config";

const H = 3_600_000;
afterEach(() => {
  delete process.env.CLEANUP_STALE_TEMP_AGE_HOURS;
  delete process.env.CLEANUP_ABANDONED_SNAPSHOT_AGE_HOURS;
  delete process.env.CLEANUP_UNREFERENCED_CANDIDATE_AGE_HOURS;
  delete process.env.TENANT_STORAGE_QUOTA_BYTES;
});

describe("cleanup config", () => {
  test("defaults", () => {
    expect(resolveStaleTempAgeMs()).toBe(DEFAULT_STALE_TEMP_AGE_HOURS * H);
    expect(resolveAbandonedSnapshotAgeMs()).toBe(DEFAULT_ABANDONED_SNAPSHOT_AGE_HOURS * H);
    expect(resolveUnreferencedCandidateAgeMs()).toBe(DEFAULT_UNREFERENCED_CANDIDATE_AGE_HOURS * H);
    expect(resolveTenantStorageQuotaBytes()).toBeNull();
  });
  test("invalid env falls back to default", () => {
    process.env.CLEANUP_STALE_TEMP_AGE_HOURS = "0";
    expect(resolveStaleTempAgeMs()).toBe(DEFAULT_STALE_TEMP_AGE_HOURS * H);
    process.env.CLEANUP_STALE_TEMP_AGE_HOURS = "-1";
    expect(resolveStaleTempAgeMs()).toBe(DEFAULT_STALE_TEMP_AGE_HOURS * H);
    process.env.CLEANUP_STALE_TEMP_AGE_HOURS = "abc";
    expect(resolveStaleTempAgeMs()).toBe(DEFAULT_STALE_TEMP_AGE_HOURS * H);
    process.env.CLEANUP_STALE_TEMP_AGE_HOURS = "";
    expect(resolveStaleTempAgeMs()).toBe(DEFAULT_STALE_TEMP_AGE_HOURS * H);
  });
  test("quota invalid falls back to null", () => {
    for (const v of ["0", "-5", "abc", "1.5", ""]) {
      process.env.TENANT_STORAGE_QUOTA_BYTES = v;
      expect(resolveTenantStorageQuotaBytes()).toBeNull();
    }
    process.env.TENANT_STORAGE_QUOTA_BYTES = "1024";
    expect(resolveTenantStorageQuotaBytes()).toBe(1024);
  });
});
