import { databasePool } from "../database/pool";
import type { AuthContext } from "./context";

type NucleusMeResponse = {
  success?: boolean;
  data?: {
    user?: { id?: string; isGod?: boolean };
    claims?: Array<{ action?: string; path?: string }>;
  };
};

export async function resolveNucleusAuth(
  request: Request,
): Promise<AuthContext | null> {
  const tenantId = request.headers.get("x-tenant-id");
  const cookie = request.headers.get("cookie");

  if (!tenantId || !cookie) return null;

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
     WHERE subdomain = $1 OR id::text = $1 OR schema_name = $1
     LIMIT 1`,
    [tenantId],
  );
  const schemaName = tenant.rows[0]?.schema_name;

  if (!schemaName) return null;

  const claims = user.isGod
    ? ["*"]
    : (auth.data?.claims ?? [])
        .filter((claim) => claim.action && claim.path)
        .map((claim) => `${claim.action}.${claim.path}`);

  return {
    userId: user.id,
    schemaName,
    claims,
    authType: "nucleus-session",
  };
}
