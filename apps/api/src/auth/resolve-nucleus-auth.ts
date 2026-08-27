import { createHash } from "node:crypto";

import { databasePool } from "../database/pool";
import type { AuthContext } from "./context";

const AUTH_CACHE_TTL_MS = 5_000;
const AUTH_CACHE_MAX_ENTRIES = 500;

type CachedAuth = {
  expiresAt: number;
  value: Promise<AuthContext | null>;
};

const authCache = new Map<string, CachedAuth>();

type NucleusMeResponse = {
  success?: boolean;
  data?: {
    user?: { id?: string; isGod?: boolean };
  };
};

type StoredClaim = {
  action: string;
  path: string;
};

export async function resolveNucleusAuth(
  request: Request,
): Promise<AuthContext | null> {
  const tenantId = request.headers.get("x-tenant-id");
  const cookie = request.headers.get("cookie");

  if (!tenantId || !cookie) return null;

  const cacheKey = createAuthCacheKey(
    tenantId,
    cookie,
    request.headers.get("x-service-id") ?? "",
  );
  const now = Date.now();
  const cached = authCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached) authCache.delete(cacheKey);
  pruneAuthCache(now);

  const value = resolveUncachedNucleusAuth(request, tenantId, cookie);
  authCache.set(cacheKey, {
    expiresAt: now + AUTH_CACHE_TTL_MS,
    value,
  });

  try {
    const auth = await value;
    if (!auth) authCache.delete(cacheKey);
    return auth;
  } catch (error) {
    authCache.delete(cacheKey);
    throw error;
  }
}

async function resolveUncachedNucleusAuth(
  request: Request,
  tenantId: string,
  cookie: string,
): Promise<AuthContext | null> {

  const response = await fetch(new URL("/auth/me", request.url), {
    headers: {
      cookie,
      "x-service-id": request.headers.get("x-service-id") ?? "",
      "x-tenant-id": tenantId,
    },
  });

  if (!response.ok) return null;

  const auth = (await response.json()) as NucleusMeResponse;
  const user = auth.data?.user;

  if (!auth.success || !user?.id) return null;

  const tenant = await databasePool.query<{ schema_name: string }>(
    `SELECT schema_name FROM main.tenants
     WHERE (subdomain = $1 OR id::text = $1 OR schema_name = $1)
       AND status = 'active'
     LIMIT 1`,
    [tenantId],
  );
  const schemaName = tenant.rows[0]?.schema_name;

  if (!schemaName) return null;

  const claims = user.isGod
    ? ["*"]
    : await resolveUserClaims(schemaName, user.id);

  return {
    userId: user.id,
    schemaName,
    claims,
    authType: "nucleus-session",
  };
}

function createAuthCacheKey(
  tenantId: string,
  cookie: string,
  serviceId: string,
): string {
  return createHash("sha256")
    .update(`${tenantId}\0${serviceId}\0${cookie}`)
    .digest("hex");
}

function pruneAuthCache(now: number): void {
  for (const [key, entry] of authCache) {
    if (entry.expiresAt <= now) authCache.delete(key);
  }

  while (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldestKey = authCache.keys().next().value;
    if (oldestKey === undefined) break;
    authCache.delete(oldestKey);
  }
}

async function resolveUserClaims(
  schemaName: string,
  userId: string,
): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Unsafe PostgreSQL schema identifier: ${schemaName}`);
  }

  const result = await databasePool.query<StoredClaim>(
    `SELECT DISTINCT claims.action, claims.path
     FROM ${schemaName}.user_roles
     INNER JOIN ${schemaName}.roles
       ON roles.id = user_roles.role_id
     INNER JOIN ${schemaName}.role_claims
       ON role_claims.role_id = roles.id
     INNER JOIN ${schemaName}.claims
       ON claims.id = role_claims.claim_id
     WHERE user_roles.user_id = $1
       AND roles.is_active = true
       AND role_claims.is_active = true
       AND claims.is_active = true`,
    [userId],
  );

  return result.rows.map((claim) => `${claim.action}.${claim.path}`);
}
