import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const { Pool } = pg;

const databaseUrl = requiredEnv("DATABASE_URL");
const nucleusUrl = process.env.NUCLEUS_URL ?? "http://localhost:4000";
const subdomain = process.env.DEV_TENANT_SUBDOMAIN ?? "ampersand-dev";
const email = requiredEnv("DEV_TENANT_ADMIN_EMAIL");
const password = requiredEnv("DEV_TENANT_ADMIN_PASSWORD");
const pool = new Pool({ connectionString: databaseUrl });

try {
  let tenant = await findTenant(subdomain);

  if (!tenant) {
    const response = await fetch(`${nucleusUrl}/tenants/self-signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        subdomain,
        plan: "development",
        companyName: "Ampersand Development",
      }),
    });
    const body = await response.json();

    if (!response.ok || !body.success) {
      throw new Error(
        `Nucleus tenant provisioning failed: ${JSON.stringify(body)}`,
      );
    }

    tenant = await findTenant(subdomain);
  }

  if (!tenant)
    throw new Error("Nucleus did not register the provisioned tenant");
  assertIdentifier(tenant.schema_name);

  await pool.query(
    "UPDATE main.tenants SET trusted_sources = $1::jsonb WHERE subdomain = $2",
    [
      JSON.stringify([
        {
          allow_header_auth: true,
          allowed_services: ["ampersand-web"],
        },
      ]),
      subdomain,
    ],
  );

  const migrationDirectory = join(import.meta.dir, "..", "migrations");
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (migrationNames.length === 0) {
    throw new Error("No database migrations were found");
  }

  const migrations = await Promise.all(
    migrationNames.map(async (name) => ({
      name,
      sql: await readFile(join(migrationDirectory, name), "utf8"),
    })),
  );

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO "${tenant.schema_name}"`);
    for (const migration of migrations) {
      await client.query(migration.sql);
      console.log(`Applied migration: ${migration.name}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.log(`Tenant ${subdomain} is ready in schema ${tenant.schema_name}`);
} finally {
  await pool.end();
}

async function findTenant(
  tenantSubdomain: string,
): Promise<{ schema_name: string } | null> {
  const result = await pool.query<{ schema_name: string }>(
    "SELECT schema_name FROM main.tenants WHERE subdomain = $1 AND status = 'active'",
    [tenantSubdomain],
  );
  return result.rows[0] ?? null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL schema identifier: ${value}`);
  }
}
