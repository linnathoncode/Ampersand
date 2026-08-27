import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { assertTenantSchemaName } from "../database/tenant-transaction";

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;
const DATA_SCHEMA_SUFFIX = "_data";

export function tenantDataSchemaName(tenantSchemaName: string): string {
  assertTenantSchemaName(tenantSchemaName);

  const directName = `${tenantSchemaName}${DATA_SCHEMA_SUFFIX}`;
  if (directName.length <= POSTGRES_IDENTIFIER_MAX_LENGTH) return directName;

  const digest = createHash("sha256").update(tenantSchemaName).digest("hex").slice(0, 8);
  return `${tenantSchemaName.slice(0, 54)}_${digest}`;
}

export async function ensureTenantDataSchema(
  client: PoolClient,
  tenantSchemaName: string,
): Promise<string> {
  const dataSchemaName = tenantDataSchemaName(tenantSchemaName);
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${dataSchemaName}"`);
  return dataSchemaName;
}
