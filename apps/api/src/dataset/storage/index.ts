import { FilesystemSnapshotStorage } from "./filesystem-store";
import { writeParquetSnapshot } from "./parquet-writer";
import type { SnapshotStorage } from "./types";

export type {
  ParquetWriter,
  SnapshotStorage,
  SnapshotStorageColumn,
  SnapshotStorageRow,
  SnapshotStorageRows,
  WrittenSnapshot,
} from "./types";

export function createSnapshotStorage(baseDirectory: string): SnapshotStorage {
  return new FilesystemSnapshotStorage(baseDirectory, writeParquetSnapshot);
}
