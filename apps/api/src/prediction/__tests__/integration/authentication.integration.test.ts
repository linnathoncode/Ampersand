import { expect, test } from "bun:test";

import { createApp } from "../../../app";

test("Nucleus rejects spoofed internal authentication headers", async () => {
  const app = await createApp();
  const response = await app.handle(
    new Request("http://localhost/predictions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": "11111111-1111-4111-8111-111111111111",
        "x-tenant-schema": "tenant_ampersand_dev",
        "x-user-claims": "invoke.tool_definitions",
        "x-auth-type": "jwt",
      },
      body: JSON.stringify({
        toolName: "predict_energy_usage",
        inputs: {
          temperature: 20,
          occupancy: 4,
        },
      }),
    }),
  );

  expect(response.status).toBe(401);
});
