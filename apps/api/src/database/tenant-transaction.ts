import type { PoolClient } from "pg";

import { databasePool } from "./pool";

export async function withTenantTransaction<T>(
  schemaName: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertTenantSchemaName(schemaName);

  const client = await databasePool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`
            SET LOCAL search_path to ${schemaName}
            `);

    const result = await operation(client);

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assertTenantSchemaName(schemaName: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
    throw new Error(`Unsafe PosgreSQL schema identifier: ${schemaName}`);
  }
}
