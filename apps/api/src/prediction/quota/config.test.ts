import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_DAILY_TENANT_INFERENCE_QUOTA,
  getDailyTenantInferenceQuota,
} from "./config";

const originalQuota = process.env.INFERENCE_TENANT_DAILY_QUOTA;

afterEach(() => {
  if (originalQuota === undefined) {
    delete process.env.INFERENCE_TENANT_DAILY_QUOTA;
  } else {
    process.env.INFERENCE_TENANT_DAILY_QUOTA = originalQuota;
  }
});

describe("tenant inference quota configuration", () => {
  test("uses the default when no quota is configured", () => {
    delete process.env.INFERENCE_TENANT_DAILY_QUOTA;
    expect(getDailyTenantInferenceQuota()).toBe(
      DEFAULT_DAILY_TENANT_INFERENCE_QUOTA,
    );
  });

  test("accepts a positive integer", () => {
    process.env.INFERENCE_TENANT_DAILY_QUOTA = "250";
    expect(getDailyTenantInferenceQuota()).toBe(250);
  });

  test.each(["0", "-1", "1.5", "invalid"])(
    "rejects invalid quota value %s",
    (value) => {
      process.env.INFERENCE_TENANT_DAILY_QUOTA = value;
      expect(() => getDailyTenantInferenceQuota()).toThrow(
        "INFERENCE_TENANT_DAILY_QUOTA must be a positive integer",
      );
    },
  );
});
