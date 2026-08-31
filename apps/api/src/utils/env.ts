import { isAbsolute, resolve } from "node:path";

export function resolvePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function resolvePositiveHours(value: string | undefined, fallback: number): number {
  return resolvePositiveInt(value, fallback);
}

export function resolveStorageRoot(explicit?: string): string {
  const raw = explicit ?? process.env.ARTIFACT_STORAGE_PATH;
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed) {
      if (isAbsolute(trimmed)) {
        return trimmed;
      }
      return resolve(import.meta.dir, "../../../../", trimmed);
    }
  }
  return resolve(import.meta.dir, "../../../../artifacts");
}
