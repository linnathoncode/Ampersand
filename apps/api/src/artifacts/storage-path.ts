import { isAbsolute, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../../..");

export function resolveArtifactStoragePath(): string {
  const configuredPath = process.env.ARTIFACT_STORAGE_PATH ?? "./artifacts";

  return isAbsolute(configuredPath)
    ? configuredPath
    : resolve(repositoryRoot, configuredPath);
}
