import { describe, expect, test } from "bun:test";

import { createTenantQuotaKey, getNextUtcDay } from "./tenant-quota";

describe("tenant quota window", () => {
  test("creates a tenant-specific UTC daily key", () => {
    const now = new Date("2026-08-18T21:45:00.000Z");
    expect(createTenantQuotaKey("tenant_ampersand_dev", now)).toBe(
      "inference-quota:tenant_ampersand_dev:2026-08-18",
    );
  });

  test("resets at the beginning of the next UTC day", () => {
    const now = new Date("2026-12-31T23:59:59.000Z");
    expect(getNextUtcDay(now).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});
