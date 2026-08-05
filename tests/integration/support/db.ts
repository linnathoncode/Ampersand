import pg from "pg";

const { Pool } = pg;

export function createPool(): pg.Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  return new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
  });
}

export async function resolveTenantSchema(
  pool: pg.Pool,
  subdomain: string,
): Promise<string> {
  const result = await pool.query<{ schema_name: string }>(
    "SELECT schema_name FROM main.tenants WHERE subdomain = $1 AND status = 'active'",
    [subdomain],
  );
  const schemaName = result.rows[0]?.schema_name;
  if (!schemaName) {
    throw new Error(
      `Active tenant '${subdomain}' was not found. ` +
        "Start PostgreSQL (bun run infra:up) and bootstrap the tenant (bun run tenant:bootstrap).",
    );
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Unsafe PostgreSQL schema identifier: ${schemaName}`);
  }
  return schemaName;
}

export async function beginScoped(
  client: pg.PoolClient,
  schemaName: string,
): Promise<void> {
  await client.query("BEGIN");
  await client.query(`SET LOCAL search_path TO "${schemaName}"`);
}
