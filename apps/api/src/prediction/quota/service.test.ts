import { afterEach, describe, expect, test } from "bun:test";

import { reserveTenantInferenceQuota } from "./service";
import type { TenantQuotaStore } from "./tenant-quota";

const originalQuota = process.env.INFERENCE_TENANT_DAILY_QUOTA;
const now = new Date("2026-08-18T12:00:00.000Z");
const resetsAt = new Date("2026-08-19T00:00:00.000Z");

afterEach(() => {
  if (originalQuota === undefined) {
    delete process.env.INFERENCE_TENANT_DAILY_QUOTA;
  } else {
    process.env.INFERENCE_TENANT_DAILY_QUOTA = originalQuota;
  }
});

describe("tenant inference quota service", () => {
  test("returns an allowed reservation", async () => {
    process.env.INFERENCE_TENANT_DAILY_QUOTA = "10";
    const store: TenantQuotaStore = {
      reserve: async (input) => {
        expect(input).toEqual({
          schemaName: "tenant_ampersand_dev",
          limit: 10,
          now,
        });
        return {
          allowed: true,
          used: 4,
          limit: 10,
          remaining: 6,
          resetsAt,
        };
      },
      release: async () => {},
    };

    const result = await reserveTenantInferenceQuota(
      store,
      "tenant_ampersand_dev",
      now,
    );
    expect(result).toEqual({
      ok: true,
      reservation: {
        allowed: true,
        used: 4,
        limit: 10,
        remaining: 6,
        resetsAt,
      },
    });
  });

  test("returns a structured response when quota is exhausted", async () => {
    process.env.INFERENCE_TENANT_DAILY_QUOTA = "10";
    const store: TenantQuotaStore = {
      reserve: async () => ({
        allowed: false,
        used: 10,
        limit: 10,
        remaining: 0,
        resetsAt,
      }),
      release: async () => {},
    };

    const result = await reserveTenantInferenceQuota(
      store,
      "tenant_ampersand_dev",
      now,
    );
    expect(result).toEqual({
      ok: false,
      status: 429,
      body: {
        error: {
          code: "TENANT_INFERENCE_QUOTA_EXCEEDED",
          message: "The tenant's daily inference quota has been reached",
          limit: 10,
          used: 10,
          resetsAt: resetsAt.toISOString(),
        },
      },
    });
  });
});
