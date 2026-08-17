import { expect, test } from "bun:test";

import { withTenantTransaction } from "./tenant-transaction";

test("rejects an unsafe tenant schema before running database work", async () => {
  let operationCalled = false;

  await expect(
    withTenantTransaction('tenant_a"; DROP SCHEMA public; --', async () => {
      operationCalled = true;
    }),
  ).rejects.toThrow("Unsafe PosgreSQL schema identifier");

  expect(operationCalled).toBe(false);
});
