import { describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";

import { completeToolPrediction } from "./complete-prediction";

const modelVersionId = "22222222-2222-4222-8222-222222222222";

describe("complete prediction", () => {
  test("returns and stores a successful prediction", async () => {
    const result = await completeToolPrediction(
      {} as PoolClient,
      "tenant_ampersand_dev",
      "33333333-3333-4333-8333-333333333333",
      {
        accepted: {
          kind: "accepted",
          toolDefinitionId: "11111111-1111-4111-8111-111111111111",
          modelVersionId,
          modelVersion: 1,
          inputs: {
            temperature: 48,
          },
          warnings: [
            "temperature is close to the maximum accepted value of 50",
          ],
        },
        request: {
          toolName: "predict_energy_usage",
          conversationId: "conversation-1",
          inputs: {
            temperature: 48,
          },
        },
        inference: {
          prediction: 124.6,
          uncertainty: 3.2,
        },
        latencyMs: 18,
      },
      {
        storeSuccess: async (_client, schemaName, input) => {
          expect(schemaName).toBe("tenant_ampersand_dev");
          expect(input).toMatchObject({
            modelVersionId,
            conversationId: "conversation-1",
            prediction: 124.6,
            uncertainty: 3.2,
            warnings: [
              "temperature is close to the maximum accepted value of 50",
            ],
            latencyMs: 18,
          });

          return "44444444-4444-4444-8444-444444444444";
        },
      },
    );

    expect(result).toEqual({
      outcome: "prediction",
      prediction: 124.6,
      uncertainty: 3.2,
      modelVersionId,
      modelVersion: 1,
      warnings: [
        "temperature is close to the maximum accepted value of 50",
      ],
      rejection: null,
    });
  });
});
