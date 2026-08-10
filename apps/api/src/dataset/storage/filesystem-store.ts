import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  ParquetWriter,
  SnapshotStorage,
  SnapshotStorageRows,
  WrittenSnapshot,
} from "./types";

export class FilesystemSnapshotStorage implements SnapshotStorage {
  constructor(
    private readonly baseDirectory: string,
    private readonly writer: ParquetWriter,
  ) {}

  async writeSnapshot(snapshot: SnapshotStorageRows): Promise<WrittenSnapshot> {
    let rowCount = 0;
    const countedRows = (async function* () {
      for await (const batch of snapshot.rows) {
        rowCount += batch.length;
        yield batch;
      }
    })();
    const bytes = await this.writer({ ...snapshot, rows: countedRows });
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");

    const filename = `${randomUUID()}.parquet`;
    const finalPath = resolve(this.baseDirectory, filename);
    const tempPath = `${finalPath}.tmp`;

    await mkdir(this.baseDirectory, { recursive: true });

    try {
      await writeFile(tempPath, bytes);
      await rename(tempPath, finalPath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }

    return {
      uri: filename,
      contentSha256,
      rowCount,
    };
  }

  async deleteSnapshot(uri: string): Promise<void> {
    await unlink(resolve(this.baseDirectory, uri)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  async verifySnapshot(uri: string, contentSha256: string): Promise<boolean> {
    let bytes: Buffer;
    try {
      bytes = await readFile(resolve(this.baseDirectory, uri));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    const actual = createHash("sha256").update(bytes).digest("hex");
    return actual === contentSha256;
  }

  resolveUri(uri: string): string {
    return resolve(this.baseDirectory, uri);
  }
}