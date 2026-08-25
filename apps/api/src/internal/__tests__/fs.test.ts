import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  buildModelArtifactPath,
  deleteArtifact,
  promoteArtifact,
  resolveTempArtifactPath,
  verifyPromotedArtifact,
} from "../fs";

const temporaryDirectories: string[] = [];

function makeStorageRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ampersand-internal-fs-")).then((directory) => {
    temporaryDirectories.push(directory);
    return directory;
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("resolveTempArtifactPath", () => {
  test("resolves a temporary file name inside the storage root", async () => {
    const root = await makeStorageRoot();

    const resolution = resolveTempArtifactPath(root, "job.onnx.tmp");

    expect(resolution).toEqual({
      ok: true,
      absolutePath: join(root, "job.onnx.tmp"),
    });
  });

  test("rejects an empty URI", () => {
    const resolution = resolveTempArtifactPath("/tmp/root", "");

    expect(resolution.ok).toBe(false);
  });

  test("rejects an absolute URI", () => {
    const resolution = resolveTempArtifactPath(
      "/tmp/root",
      "/etc/passwd",
    );

    expect(resolution.ok).toBe(false);
  });

  test("rejects a traversal escape", () => {
    const resolution = resolveTempArtifactPath(
      "/tmp/root",
      "../outside.onnx.tmp",
    );

    expect(resolution.ok).toBe(false);
  });

  test("rejects a URI under the immutable models tree", () => {
    const resolution = resolveTempArtifactPath(
      "/tmp/root",
      "models/dd/v1/job.onnx",
    );

    expect(resolution.ok).toBe(false);
  });
});

describe("buildModelArtifactPath", () => {
  test("follows the immutable versioned scheme", async () => {
    const root = await makeStorageRoot();

    const path = buildModelArtifactPath(
      root,
      "33333333-3333-4333-8333-333333333333",
      2,
      "11111111-1111-4111-8111-111111111111",
    );

    expect(path).toBe(
      join(
        root,
        "models/33333333-3333-4333-8333-333333333333/v2/11111111-1111-4111-8111-111111111111.onnx",
      ),
    );
  });
});

describe("promoteArtifact", () => {
  test("moves the payload to the final path and removes the temp file", async () => {
    const root = await makeStorageRoot();
    const tempPath = join(root, "job.onnx.tmp");
    await writeFile(tempPath, "model bytes");
    const finalPath = join(root, "models", "dd", "v1", "job.onnx");

    const result = await promoteArtifact(tempPath, finalPath);

    expect(result).toEqual({ ok: true });
    expect(await Bun.file(finalPath).text()).toBe("model bytes");
    expect(await Bun.file(tempPath).exists()).toBe(false);
  });

  test("never clobbers an existing final path and keeps the temp file", async () => {
    const root = await makeStorageRoot();
    const tempPath = join(root, "job.onnx.tmp");
    await writeFile(tempPath, "new bytes");
    const finalPath = join(root, "models", "dd", "v1", "job.onnx");
    await mkdir(join(root, "models", "dd", "v1"), { recursive: true });
    await writeFile(finalPath, "existing bytes");

    const result = await promoteArtifact(tempPath, finalPath);

    expect(result.ok).toBe(false);
    expect(await Bun.file(finalPath).text()).toBe("existing bytes");
    expect(await Bun.file(tempPath).text()).toBe("new bytes");
  });

  test("fails structurally when the temp file is missing", async () => {
    const root = await makeStorageRoot();

    const result = await promoteArtifact(
      join(root, "missing.onnx.tmp"),
      join(root, "final.onnx"),
    );

    expect(result.ok).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "keeps the promotion when only the temp cleanup fails",
    async () => {
    const root = await makeStorageRoot();
    const workDirectory = join(root, "work");
    await mkdir(workDirectory, { recursive: true });
    const tempPath = join(workDirectory, "job.onnx.tmp");
    await writeFile(tempPath, "linked bytes");
    const finalPath = join(root, "models", "dd", "v1", "job.onnx");

    // Unlinking needs write permission on the temp file's directory, so a
    // read-only work directory fails only the cleanup step, not the link.
    await chmod(workDirectory, 0o500);

    try {
      const result = await promoteArtifact(tempPath, finalPath);

      expect(result).toEqual({ ok: true });
      expect(await Bun.file(finalPath).text()).toBe("linked bytes");
      expect(await Bun.file(tempPath).exists()).toBe(true);
    } finally {
      await chmod(workDirectory, 0o700);
    }
    },
  );
});

describe("verifyPromotedArtifact", () => {
  test("passes when digest and size match", async () => {
    const root = await makeStorageRoot();
    const finalPath = join(root, "final.onnx");
    await writeFile(finalPath, Buffer.alloc(2_000_000, 7));

    const result = await verifyPromotedArtifact(
      finalPath,
      createHash("sha256").update(Buffer.alloc(2_000_000, 7)).digest("hex"),
      2_000_000,
    );

    expect(result).toEqual({ ok: true });
  });

  test("reports a size mismatch", async () => {
    const root = await makeStorageRoot();
    const finalPath = join(root, "final.onnx");
    await writeFile(finalPath, "bytes");

    const result = await verifyPromotedArtifact(finalPath, "a".repeat(64), 6);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("SIZE_MISMATCH");
    }
  });

  test("reports a checksum mismatch", async () => {
    const root = await makeStorageRoot();
    const finalPath = join(root, "final.onnx");
    await writeFile(finalPath, "bytes");

    const result = await verifyPromotedArtifact(
      finalPath,
      createHash("sha256").update("other").digest("hex"),
      5,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("CHECKSUM_MISMATCH");
    }
  });

  test("reports a missing promoted file", async () => {
    const result = await verifyPromotedArtifact(
      "/nonexistent/final.onnx",
      "a".repeat(64),
      5,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ARTIFACT_NOT_FOUND");
    }
  });
});

describe("deleteArtifact", () => {
  test("removes an existing file and tolerates a missing one", async () => {
    const root = await makeStorageRoot();
    const path = join(root, "artifact.onnx");
    await writeFile(path, "bytes");

    await deleteArtifact(path);
    expect(await Bun.file(path).exists()).toBe(false);

    await deleteArtifact(path);
  });
});
