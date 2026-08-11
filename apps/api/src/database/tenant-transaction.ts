import type { PoolClient } from "pg";

import { databasePool } from "./pool";

export type TenantTransactionContext = {
  onRollback(callback: () => void | Promise<void>): void;
};

export async function withTenantTransaction<T>(
  schemaName: string,
  operation: (client: PoolClient, context: TenantTransactionContext) => Promise<T>,
): Promise<T> {
  assertTenantSchemaName(schemaName);

  const client = await databasePool.connect();
  const rollbackCallbacks: (() => void | Promise<void>)[] = [];

  try {
    await client.query("BEGIN");
    await client.query(`
            SET LOCAL search_path to ${schemaName}
            `);

    const result = await operation(client, {
      onRollback(callback) {
        rollbackCallbacks.push(callback);
      },
    });

    await client.query("COMMIT");
    rollbackCallbacks.length = 0;

    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    for (const callback of rollbackCallbacks.reverse()) {
      await Promise.resolve()
        .then(callback)
        .catch(() => {});
    }
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
