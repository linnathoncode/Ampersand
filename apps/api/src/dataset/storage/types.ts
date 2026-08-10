import type { DatasetColumnType } from "@ampersand/contracts";

export type SnapshotStorageColumn = {
  name: string;
  dataType: DatasetColumnType;
  isNullable: boolean;
};

export type SnapshotStorageRow = (string | number | boolean | bigint | Date | null)[];

export type SnapshotStorageRows = {
  columns: SnapshotStorageColumn[];
  rows: AsyncIterable<SnapshotStorageRow[]>;
};

export type WrittenSnapshot = {
  uri: string;
  contentSha256: string;
  rowCount: number;
};

export type ParquetWriter = (
  snapshot: SnapshotStorageRows,
) => Promise<Uint8Array>;

export interface SnapshotStorage {
  writeSnapshot(snapshot: SnapshotStorageRows): Promise<WrittenSnapshot>;
  deleteSnapshot(uri: string): Promise<void>;
  verifySnapshot(uri: string, contentSha256: string): Promise<boolean>;
  resolveUri(uri: string): string;
}