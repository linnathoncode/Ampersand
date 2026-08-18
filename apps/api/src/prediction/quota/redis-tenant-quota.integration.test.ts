import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";

import { RedisTenantQuotaStore } from "./redis-tenant-quota";
import { createTenantQuotaKey } from "./tenant-quota";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
const store = new RedisTenantQuotaStore(redis);
const keys = new Set<string>();

beforeAll(async () => {
  expect(await redis.ping()).toBe("PONG");
});

afterAll(async () => {
  if (keys.size > 0) {
    await redis.del(...keys);
  }
  await redis.quit();
});

function uniqueSchema(): string {
  return `tenant_quota_${randomUUID().replaceAll("-", "")}`;
}

describe("Redis tenant quota store", () => {
  test("atomically enforces the limit across parallel reservations", async () => {
    const now = new Date();
    const schemaName = uniqueSchema();
    const key = createTenantQuotaKey(schemaName, now);
    keys.add(key);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store.reserve({ schemaName, limit: 5, now }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);
    expect(await redis.get(key)).toBe("5");
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });

  test("releases reservations without reducing usage below zero", async () => {
    const now = new Date();
    const schemaName = uniqueSchema();
    const key = createTenantQuotaKey(schemaName, now);
    keys.add(key);

    await store.reserve({ schemaName, limit: 5, now });
    await Promise.all(
      Array.from({ length: 5 }, () => store.release(schemaName, now)),
    );

    expect(await redis.get(key)).toBe("0");
  });

  test("keeps different tenants in separate counters", async () => {
    const now = new Date();
    const firstSchema = uniqueSchema();
    const secondSchema = uniqueSchema();
    const firstKey = createTenantQuotaKey(firstSchema, now);
    const secondKey = createTenantQuotaKey(secondSchema, now);
    keys.add(firstKey);
    keys.add(secondKey);

    await store.reserve({ schemaName: firstSchema, limit: 5, now });
    await store.reserve({ schemaName: firstSchema, limit: 5, now });
    await store.reserve({ schemaName: secondSchema, limit: 5, now });

    expect(await redis.get(firstKey)).toBe("2");
    expect(await redis.get(secondKey)).toBe("1");
  });
});
