import type Redis from "ioredis";

import {
  createTenantQuotaKey,
  getNextUtcDay,
  type ReserveTenantQuotaInput,
  type TenantQuotaReservation,
  type TenantQuotaStore,
} from "./tenant-quota";

const RESERVE_QUOTA_SCRIPT = `
    local current = tonumber(redis.call("GET", KEYS[1]) or "0")
    local limit = tonumber(ARGV[1])
    local expiresAt = tonumber(ARGV[2])

    if current >= limit then
        return {0, current}
    end

    local used = redis.call("INCR", KEYS[1])

    if used == 1 then
        redis.call("EXPIREAT", KEYS[1], expiresAt)
    end

    return {1, used}
`;

const RELEASE_QUOTA_SCRIPT = `
    local current = tonumber(redis.call("GET", KEYS[1]) or "0")

    if current <= 0 then
        return 0
    end

    return redis.call("DECR", KEYS[1])
`;

export class RedisTenantQuotaStore implements TenantQuotaStore {
  constructor(private readonly redis: Redis) {}

  async reserve(
    input: ReserveTenantQuotaInput,
  ): Promise<TenantQuotaReservation> {
    const resetsAt = getNextUtcDay(input.now);
    const key = createTenantQuotaKey(input.schemaName, input.now);

    // lua arrays start index at 1
    // eval(script, keyCount, KEYS[1], ARGV[1], ARGV[2])
    const result = await this.redis.eval(
      RESERVE_QUOTA_SCRIPT,
      1,
      key,
      input.limit,
      Math.floor(resetsAt.getTime() / 1000),
    );

    const [allowedValue, usedValue] = result as [number, number];
    const allowed = allowedValue === 1;
    const used = Number(usedValue);

    if (!allowed) {
      return {
        allowed: false,
        used,
        limit: input.limit,
        remaining: 0,
        resetsAt,
      };
    }

    return {
      allowed: true,
      used,
      limit: input.limit,
      remaining: input.limit - used,
      resetsAt,
    };
  }

  async release(schemaName: string, now: Date): Promise<void> {
    const key = createTenantQuotaKey(schemaName, now);

    await this.redis.eval(RELEASE_QUOTA_SCRIPT, 1, key);
  }
}
