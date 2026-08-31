import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const TEMP_FILE_PATTERN = /\.tmp$/i;
// TEMP_FILE_PATTERN is intentionally narrow: only files ending in .tmp are
// considered temporary. Current writers (`filesystem-store` atomic rename,
// `parquet-writer` worker temps) all use .tmp suffix. If a new temp naming
// scheme is introduced (e.g. .part, .tmp-*), update the pattern here.

export interface StaleTempFile {
  storageUri: string;
  sizeBytes: number;
  absolutePath: string;
}

/**
 * Lists stale temporary files under the storage root. A file is a candidate
 * when its name ends in a temp suffix and its modification time is older
 * than `staleAgeMs`. The scan walks the entire tree including the `models/`
 * subtree so stale `.tmp` files under `models/<definition>/vN/` are reclaimed.
 * Snapshot and model artifact files are never matched here because they do not
 * end in `.tmp`.
 */
export async function findStaleTempFiles(
  storageRoot: string,
  staleAgeMs: number,
): Promise<StaleTempFile[]> {
  const root = resolve(storageRoot);
  const cutoff = Date.now() - staleAgeMs;
  const found: StaleTempFile[] = [];

  await walk(root, root, cutoff, found);

  return found;
}

async function walk(
  directory: string,
  root: string,
  cutoff: number,
  found: StaleTempFile[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);

    if (entry.isDirectory()) {
      await walk(absolutePath, root, cutoff, found);
    } else if (entry.isFile()) {
      if (!TEMP_FILE_PATTERN.test(entry.name)) {
        continue;
      }

      let info;
      try {
        info = await stat(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (info.mtimeMs >= cutoff) {
        continue;
      }

      found.push({
        storageUri: relative(root, absolutePath).split(sep).join("/"),
        sizeBytes: info.size,
        absolutePath,
      });
    }
  }
}
