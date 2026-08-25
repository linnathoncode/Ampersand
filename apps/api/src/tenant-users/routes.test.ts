import { afterEach, describe, expect, mock, test } from "bun:test";

import { tenantUserRoutes } from "./routes";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("tenant user invitations", () => {
  test("rejects unauthenticated requests", async () => {
    const response = await tenantUserRoutes.handle(
      new Request("http://localhost/tenant-users/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "new.user@example.com" }),
      }),
    );

    expect(response.status).toBe(401);
  });

  test("rejects users without tenant administrator permission", async () => {
    const response = await tenantUserRoutes.handle(
      authorizedRequest([]),
    );

    expect(response.status).toBe(403);
  });

  test("forwards an authorized invitation to Nucleus", async () => {
    const nucleusFetch = mock(async () =>
      Response.json({ success: true, message: "Invitation sent successfully" }),
    );
    globalThis.fetch = nucleusFetch as unknown as typeof fetch;

    const response = await tenantUserRoutes.handle(
      authorizedRequest(["invite.users"]),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(nucleusFetch).toHaveBeenCalledTimes(1);
  });
});

function authorizedRequest(claims: string[]): Request {
  return new Request("http://localhost/tenant-users/invite", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "session=test-session",
      "x-auth-type": "nucleus-session",
      "x-service-id": "ampersand-web",
      "x-tenant-id": "ampersand-dev",
      "x-tenant-schema": "tenant_ampersand_dev",
      "x-user-claims": claims.join(","),
      "x-user-id": "f27c84cd-f3af-4d9f-8389-608db845b5b7",
    },
    body: JSON.stringify({ email: "new.user@example.com" }),
  });
}
