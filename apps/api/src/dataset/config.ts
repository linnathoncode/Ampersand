/**
 * Snapshot-related operational limits, resolved from environment variables with
 * safe defaults. Every resolver falls back to its default on a missing or
 * invalid value so a typo never propagates NaN or an unbounded limit into the
 * database or the encoder.
 */

import { resolvePositiveInt } from "../utils/env";

export const DEFAULT_SNAPSHOT_BYTE_LIMIT = 64 * 1024 * 1024;
export const DEFAULT_SNAPSHOT_ROW_LIMIT = 10_000_000;
export const DEFAULT_CURSOR_BATCH_SIZE = 5_000;
export const DEFAULT_CURSOR_TIMEOUT_MS = 30_000;

export function resolveSnapshotByteLimit(): number {
  return resolvePositiveInt(
    process.env.SNAPSHOT_MAX_BYTES,
    DEFAULT_SNAPSHOT_BYTE_LIMIT,
  );
}

export function resolveSnapshotRowLimit(): number {
  return resolvePositiveInt(
    process.env.SNAPSHOT_MAX_ROWS,
    DEFAULT_SNAPSHOT_ROW_LIMIT,
  );
}

export function resolveCursorBatchSize(): number {
  return resolvePositiveInt(
    process.env.SNAPSHOT_CURSOR_BATCH_SIZE,
    DEFAULT_CURSOR_BATCH_SIZE,
  );
}

export function resolveCursorTimeoutMs(): number {
  return resolvePositiveInt(
    process.env.SNAPSHOT_CURSOR_TIMEOUT_MS,
    DEFAULT_CURSOR_TIMEOUT_MS,
  );
}
