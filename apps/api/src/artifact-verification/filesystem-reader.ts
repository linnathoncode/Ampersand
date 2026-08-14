import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ReadArtifact } from "./verify-artifact";

export function createFilesystemArtifactReader(
  baseDirectory: string,
): ReadArtifact {
  const artifactDirectory = resolve(baseDirectory);

  return async (storageUri) => {
    const artifactPath = resolve(artifactDirectory, storageUri);
    const relativePath = relative(artifactDirectory, artifactPath);

    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Artifact path is outside the configured storage directory");
    }

    return readFile(artifactPath);
  };
}
