import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type RateLimitConfig = {
  rateLimit?: {
    enabled?: boolean;
    strategy?: string;
    failClosed?: boolean;
    privateRoutes?: { window?: string; max?: number };
    byIp?: boolean;
    byUserId?: boolean;
    byEndpoint?: boolean;
  };
};

describe("Nucleus rate-limit configuration", () => {
  test("protects private endpoints with a fail-closed sliding window", () => {
    const config = JSON.parse(
      readFileSync(new URL("./config.json", import.meta.url), "utf8"),
    ) as RateLimitConfig;

    expect(config.rateLimit).toMatchObject({
      enabled: true,
      strategy: "sliding-window",
      failClosed: true,
      privateRoutes: {
        window: "1m",
        max: 60,
      },
      byIp: true,
      byUserId: true,
      byEndpoint: true,
    });
  });
});
