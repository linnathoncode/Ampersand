import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { verifyArtifact, verifyWorkerProvenance } from "../verify-artifact";

const bytes = new TextEncoder().encode("verified model bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const trustedWorkers = new Set(["worker-1"]);

const input = {
  storageUri: "model.onnx",
  expectedSha256: sha256,
  expectedSizeBytes: bytes.byteLength,
  producerWorkerId: "worker-1",
};

describe("artifact verification", () => {
  test("accepts a trusted worker", () => {
    expect(verifyWorkerProvenance("worker-1", trustedWorkers)).toBeNull();
  });

  test("rejects an untrusted worker before reading the artifact", async () => {
    let readAttempted = false;

    const result = await verifyArtifact(
      { ...input, producerWorkerId: "unknown-worker" },
      trustedWorkers,
      async () => {
        readAttempted = true;
        return bytes;
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "UNTRUSTED_WORKER",
      message: "Artifact producer 'unknown-worker' is not trusted",
    });
    expect(readAttempted).toBe(false);
  });

  test("rejects an artifact that cannot be read", async () => {
    const result = await verifyArtifact(input, trustedWorkers, async () => {
      throw new Error("missing");
    });

    expect(result).toEqual({
      ok: false,
      reason: "ARTIFACT_NOT_FOUND",
      message: "The model artifact could not be read",
    });
  });

  test("rejects an artifact with an unexpected size", async () => {
    const result = await verifyArtifact(
      { ...input, expectedSizeBytes: bytes.byteLength + 1 },
      trustedWorkers,
      async () => bytes,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("SIZE_MISMATCH");
  });

  test("rejects an artifact with a mismatched checksum", async () => {
    const result = await verifyArtifact(
      { ...input, expectedSha256: "0".repeat(64) },
      trustedWorkers,
      async () => bytes,
    );

    expect(result).toEqual({
      ok: false,
      reason: "CHECKSUM_MISMATCH",
      message: "The model artifact checksum does not match its stored checksum",
    });
  });

  test("returns the exact verified bytes", async () => {
    const result = await verifyArtifact(
      input,
      trustedWorkers,
      async () => bytes,
    );

    expect(result).toEqual({
      ok: true,
      actualSha256: sha256,
      bytes,
    });
    if (result.ok) expect(result.bytes).toBe(bytes);
  });
});
