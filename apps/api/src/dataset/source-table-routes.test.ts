import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused";

const { sourceTableRoutes } = await import("./source-table-routes");

describe("source-table routes", () => {
  test("requires authentication for table listing", async () => {
    const response = await sourceTableRoutes.handle(
      new Request("http://localhost/source-tables"),
    );
    expect(response.status).toBe(401);
  });

  test("requires dataset creation permission for imports", async () => {
    const response = await sourceTableRoutes.handle(
      new Request("http://localhost/source-tables/import", {
        method: "POST",
        headers: {
          "x-user-id": "11111111-1111-4111-8111-111111111111",
          "x-tenant-schema": "tenant_ampersand_dev",
          "x-auth-type": "bearer",
        },
      }),
    );
    expect(response.status).toBe(403);
  });
});
