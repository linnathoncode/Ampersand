import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { createFilesystemArtifactReader } from "../filesystem-reader";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("filesystem artifact reader", () => {
  test("reads an artifact inside the configured directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ampersand-artifact-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "model.onnx"), "model bytes");

    const readArtifact = createFilesystemArtifactReader(directory);
    const bytes = await readArtifact("model.onnx");

    expect(new TextDecoder().decode(bytes)).toBe("model bytes");
  });

  test("rejects a path outside the configured directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ampersand-artifact-"));
    temporaryDirectories.push(directory);

    const readArtifact = createFilesystemArtifactReader(directory);

    await expect(readArtifact("../outside.onnx")).rejects.toThrow(
      "Artifact path is outside the configured storage directory",
    );
  });
});
