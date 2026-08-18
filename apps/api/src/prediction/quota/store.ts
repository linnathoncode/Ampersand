import Redis from "ioredis";

import { RedisTenantQuotaStore } from "./redis-tenant-quota";
import type { TenantQuotaStore } from "./tenant-quota";

let redisClient: Redis | undefined;
let quotaStore: TenantQuotaStore | undefined;

export function getTenantQuotaStore(): TenantQuotaStore {
  if (quotaStore) {
    return quotaStore;
  }

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("REDIS_URL is required for tenant inference quotas");
  }

  redisClient = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  quotaStore = new RedisTenantQuotaStore(redisClient);

  return quotaStore;
}
