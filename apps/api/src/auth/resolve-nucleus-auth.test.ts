import { afterEach, describe, expect, mock, test } from "bun:test";

import { databasePool } from "../database/pool";
import { resolveNucleusAuth } from "./resolve-nucleus-auth";

const originalFetch = globalThis.fetch;
const originalQuery = databasePool.query;

afterEach(() => {
  globalThis.fetch = originalFetch;
  databasePool.query = originalQuery;
});

describe("Nucleus session resolution", () => {
  test("reuses a recent authentication result for the same session", async () => {
    const nucleusFetch = mock(async () =>
      Response.json({
        success: true,
        data: { user: { id: "f27c84cd-f3af-4d9f-8389-608db845b5b7" } },
      }),
    );
    const databaseQuery = mock(async (sql: string) =>
      sql.includes("FROM main.tenants")
        ? { rows: [{ schema_name: "tenant_ampersand_dev" }] }
        : { rows: [{ action: "invoke", path: "tool_definitions" }] },
    );

    globalThis.fetch = nucleusFetch as unknown as typeof fetch;
    databasePool.query = databaseQuery as unknown as typeof databasePool.query;

    const request = authenticatedRequest("cache-session");
    const first = await resolveNucleusAuth(request);
    const second = await resolveNucleusAuth(request);

    expect(first).toEqual(second);
    expect(first?.schemaName).toBe("tenant_ampersand_dev");
    expect(nucleusFetch).toHaveBeenCalledTimes(1);
    expect(databaseQuery).toHaveBeenCalledTimes(2);
  });

  test("does not share authentication across different session cookies", async () => {
    const nucleusFetch = mock(async () =>
      Response.json({
        success: true,
        data: { user: { id: "f27c84cd-f3af-4d9f-8389-608db845b5b7" } },
      }),
    );
    const databaseQuery = mock(async (sql: string) =>
      sql.includes("FROM main.tenants")
        ? { rows: [{ schema_name: "tenant_ampersand_dev" }] }
        : { rows: [] },
    );

    globalThis.fetch = nucleusFetch as unknown as typeof fetch;
    databasePool.query = databaseQuery as unknown as typeof databasePool.query;

    await resolveNucleusAuth(authenticatedRequest("session-one"));
    await resolveNucleusAuth(authenticatedRequest("session-two"));

    expect(nucleusFetch).toHaveBeenCalledTimes(2);
  });
});

function authenticatedRequest(session: string): Request {
  return new Request("http://localhost/training-jobs/job-id", {
    headers: {
      cookie: `session=${session}`,
      "x-service-id": "ampersand-web",
      "x-tenant-id": "ampersand-dev",
    },
  });
}
