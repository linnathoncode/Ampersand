import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused";

const { toolDefinitionRoutes } = await import("./routes");

const modelVersionId = "11111111-1111-4111-8111-111111111111";
const generationUrl =
  `http://localhost/model-versions/${modelVersionId}/tool-definition`;
const discoveryUrl = "http://localhost/tools";

describe("tool-definition generation authorization", () => {
  test("rejects an unauthenticated request", async () => {
    const response = await toolDefinitionRoutes.handle(
      new Request(generationUrl, { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      },
    });
  });

  test("rejects a user without the tool-generation claim", async () => {
    const response = await toolDefinitionRoutes.handle(
      new Request(generationUrl, {
        method: "POST",
        headers: {
          "x-user-id": "22222222-2222-4222-8222-222222222222",
          "x-tenant-schema": "tenant_ampersand_dev",
          "x-user-claims": "publish.model_versions",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Tool generation permission is required",
      },
    });
  });

  test("rejects unauthenticated tool discovery", async () => {
    const response = await toolDefinitionRoutes.handle(
      new Request(discoveryUrl),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      },
    });
  });
});
