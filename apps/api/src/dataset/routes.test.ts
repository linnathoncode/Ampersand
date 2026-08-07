import { describe, expect, test } from "bun:test";

import { datasetRoutes } from "./routes";

const url = "http://localhost/dataset-definitions";

const validBody = {
  name: "Energy predictor",
  sourceTable: "energy_readings",
  features: [{ name: "temperature", description: "Temperature" }],
  target: { name: "energy_usage", description: "Energy" },
};

function authorizedRequest(body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": "11111111-1111-4111-8111-111111111111",
      "x-tenant-schema": "ampersand_dev",
      "x-user-claims": "create.dataset_definitions",
    },
    body: JSON.stringify(body),
  });
}

describe("dataset definition authorization", () => {
  test("rejects an unauthenticated request", async () => {
    const response = await datasetRoutes.handle(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
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

  test("rejects a user without the dataset creation claim", async () => {
    const response = await datasetRoutes.handle(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": "22222222-2222-4222-8222-222222222222",
          "x-tenant-schema": "ampersand_dev",
          "x-user-claims": "get.model_versions",
        },
        body: JSON.stringify(validBody),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Dataset creation permission is required",
      },
    });
  });
});

describe("dataset definition body validation", () => {
  test("rejects a malformed request body before touching the database", async () => {
    const response = await datasetRoutes.handle(
      authorizedRequest({
        name: "Broken predictor",
        sourceTable: "energy_readings",
        features: ["temperature"],
        target: { name: "energy_usage", description: "Energy" },
      }),
    );

    expect(response.status).toBe(422);
  });
});