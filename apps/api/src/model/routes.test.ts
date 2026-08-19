import { describe, expect, test } from "bun:test";

import { modelRoutes } from "./routes";

const modelVersionId = "11111111-1111-4111-8111-111111111111";
const publishUrl = `http://localhost/model-versions/${modelVersionId}/publish`;
const retireUrl = `http://localhost/model-versions/${modelVersionId}/retire`;

describe("model publication authorization", () => {
  test("rejects an unauthenticated request", async () => {
    const response = await modelRoutes.handle(
      new Request(publishUrl, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      },
    });
  });

  test("rejects a user without the publication claim", async () => {
    const response = await modelRoutes.handle(
      new Request(publishUrl, {
        method: "POST",
        headers: {
          "x-user-id": "22222222-2222-4222-8222-222222222222",
          "x-tenant-schema": "ampersand_dev",
          "x-auth-type": "jwt",
          "x-user-claims": "get.model_versions",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Model publication permission is required",
      },
    });
  });
});

describe("model retirement authorization", () => {
  test("rejects an unauthenticated retirement request", async () => {
    const response = await modelRoutes.handle(
      new Request(retireUrl, {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      },
    });
  });

  test("rejects a user without the retirement claim", async () => {
    const response = await modelRoutes.handle(
      new Request(retireUrl, {
        method: "POST",
        headers: {
          "x-user-id": "22222222-2222-4222-8222-222222222222",
          "x-tenant-schema": "ampersand_dev",
          "x-auth-type": "jwt",
          "x-user-claims": "publish.model_versions",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Model retirement permission is required",
      },
    });
  });
});
