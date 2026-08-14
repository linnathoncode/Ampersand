import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { PoolClient } from "pg";

import { verifyStoredModelArtifact } from "../service";

const client = {} as PoolClient;
const modelVersionId = "22222222-2222-4222-8222-222222222222";
const bytes = new TextEncoder().encode("model");
const sha256 = createHash("sha256").update(bytes).digest("hex");

describe("stored model artifact verification", () => {
  test("returns not found when no active published artifact exists", async () => {
    const result = await verifyStoredModelArtifact(
      client,
      "tenant_ampersand_dev",
      modelVersionId,
      new Set(["worker-1"]),
      async () => bytes,
      async () => null,
    );

    expect(result).toEqual({
      ok: false,
      reason: "ARTIFACT_NOT_FOUND",
      message: "No active artifact was found for the published model version",
    });
  });

  test("maps stored metadata into the artifact verifier", async () => {
    const result = await verifyStoredModelArtifact(
      client,
      "tenant_ampersand_dev",
      modelVersionId,
      new Set(["worker-1"]),
      async (storageUri) => {
        expect(storageUri).toBe("model.onnx");
        return bytes;
      },
      async (_client, schemaName, requestedModelVersionId) => {
        expect(schemaName).toBe("tenant_ampersand_dev");
        expect(requestedModelVersionId).toBe(modelVersionId);

        return {
          modelVersionId,
          storageUri: "model.onnx",
          contentSha256: sha256,
          sizeBytes: bytes.byteLength,
          producerWorkerId: "worker-1",
        };
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toBe(bytes);
  });
});
