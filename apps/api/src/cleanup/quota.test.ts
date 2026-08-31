import { afterEach, describe, expect, test } from "bun:test";
import { resolveTenantStorageQuotaBytes } from "./config";

afterEach(() => { delete process.env.TENANT_STORAGE_QUOTA_BYTES; });

describe("quota resolver", () => {
  test("missing env returns null (unlimited)", () => {
    expect(resolveTenantStorageQuotaBytes()).toBeNull();
  });
  test("valid integer returned", () => {
    process.env.TENANT_STORAGE_QUOTA_BYTES = "5000";
    expect(resolveTenantStorageQuotaBytes()).toBe(5000);
  });
  test("invalid values fallback to null", () => {
    for (const v of ["0", "-1", "abc", "3.14", ""]) {
      process.env.TENANT_STORAGE_QUOTA_BYTES = v;
      expect(resolveTenantStorageQuotaBytes()).toBeNull();
    }
  });
});
