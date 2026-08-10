import { parentPort } from "node:worker_threads";

import {
  Bool,
  DateMillisecond,
  Float64,
  Int64,
  Table,
  tableToIPC,
  type Vector,
  Utf8,
  vectorFromArray,
} from "apache-arrow";
import type { DatasetColumnType } from "@ampersand/contracts";
import {
  Compression,
  Table as WasmTable,
  WriterPropertiesBuilder,
  writeParquet,
} from "parquet-wasm/node";

import type { SnapshotStorageColumn, SnapshotStorageRow } from "./types";

export type SnapshotWorkerConfig = { type: "config"; columns: SnapshotStorageColumn[] };
export type SnapshotWorkerBatch = { type: "batch"; rows: SnapshotStorageRow[] };
export type SnapshotWorkerEncode = { type: "encode" };
export type SnapshotWorkerRequest = SnapshotWorkerConfig | SnapshotWorkerBatch | SnapshotWorkerEncode;

export type SnapshotWorkerResult =
  | { type: "batch"; ok: true }
  | { type: "batch"; ok: false; error: string }
  | { type: "result"; ok: true; bytes: Uint8Array }
  | { type: "result"; ok: false; error: string };

let columns: SnapshotStorageColumn[] = [];
const columnValues: (string | number | boolean | bigint | Date | null)[][] = [];

function normalizeValue(
  dataType: DatasetColumnType,
  value: string | number | boolean | bigint | Date | null,
): string | number | boolean | bigint | null {
  if (value === null || value === undefined) return null;

  switch (dataType) {
    case "integer":
      return typeof value === "bigint"
        ? value
        : BigInt(value as string | number);
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "boolean":
      return value === true || value === false ? value : value === "t";
    case "category":
    case "text":
      return String(value);
    case "datetime":
      if (value instanceof Date) return value.getTime();
      if (typeof value === "number") return value;
      return new Date(String(value)).getTime();
    default:
      return String(value);
  }
}

function vectorForColumn(
  dataType: DatasetColumnType,
  values: (string | number | boolean | bigint | Date | null)[],
): Vector {
  switch (dataType) {
    case "integer":
      return vectorFromArray(values as (number | bigint | null)[], new Int64());
    case "number":
      return vectorFromArray(values as (number | null)[], new Float64());
    case "boolean":
      return vectorFromArray(values as (boolean | null)[], new Bool());
    case "datetime":
      return vectorFromArray(values as (number | null)[], new DateMillisecond());
    case "category":
    case "text":
    default:
      return vectorFromArray(values as (string | null)[], new Utf8());
  }
}

function encodeSnapshot(): Uint8Array {
  const vectors: Record<string, Vector> = {};
  for (const [index, column] of columns.entries()) {
    vectors[column.name] = vectorForColumn(column.dataType, columnValues[index] ?? []);
  }

  const arrowTable = new Table(vectors);
  const wasmTable = WasmTable.fromIPCStream(tableToIPC(arrowTable, "stream"));
  const writerProperties = new WriterPropertiesBuilder()
    .setCompression(Compression.SNAPPY)
    .build();

  return writeParquet(wasmTable, writerProperties);
}

parentPort?.on("message", (request: SnapshotWorkerRequest) => {
  if (!request) return;

  switch (request.type) {
    case "config":
      columns = request.columns;
      for (let index = 0; index < request.columns.length; index += 1) {
        columnValues[index] = [];
      }
      columnValues.length = request.columns.length;
      break;
    case "batch":
      try {
        for (const row of request.rows) {
          for (const [index, column] of columns.entries()) {
            (columnValues[index] ??= []).push(
              normalizeValue(column.dataType, row[index] ?? null),
            );
          }
        }
        parentPort?.postMessage({ type: "batch", ok: true });
      } catch (error) {
        parentPort?.postMessage({
          type: "batch",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    case "encode":
      try {
        parentPort?.postMessage({ type: "result", ok: true, bytes: encodeSnapshot() });
      } catch (error) {
        parentPort?.postMessage({
          type: "result",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
  }
});
