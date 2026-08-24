import { afterEach, describe, expect, it } from "vitest";

import { chatRoutes } from "./routes";

const originalApiKey = process.env.LLM_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.LLM_API_KEY;
  } else {
    process.env.LLM_API_KEY = originalApiKey;
  }
});

describe("chat routes", () => {
  it("requires authentication", async () => {
    const response = await chatRoutes.handle(createRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Authentication is required",
      },
    });
  });

  it("requires prediction tool invocation permission", async () => {
    const response = await chatRoutes.handle(
      createRequest({
        "x-user-id": "63ed43b7-2f78-4fb1-a68e-6141a8eaa53f",
        "x-tenant-schema": "tenant_ampersand_dev",
        "x-auth-type": "access-token",
      }),
    );

    expect(response.status).toBe(403);
  });

  it("reports a missing conversation model configuration", async () => {
    delete process.env.LLM_API_KEY;

    const response = await chatRoutes.handle(
      createRequest({
        "x-user-id": "63ed43b7-2f78-4fb1-a68e-6141a8eaa53f",
        "x-tenant-schema": "tenant_ampersand_dev",
        "x-auth-type": "access-token",
        "x-user-claims": "invoke.tool_definitions",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "LLM_NOT_CONFIGURED",
        message: "The conversation model is not configured",
      },
    });
  });
});

function createRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ id: "conversation-1", messages: [] }),
  });
}
