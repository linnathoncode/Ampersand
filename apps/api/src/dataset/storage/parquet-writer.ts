import { once } from "node:events";
import { Worker } from "node:worker_threads";

import type {
  SnapshotWorkerBatch,
  SnapshotWorkerConfig,
  SnapshotWorkerEncode,
  SnapshotWorkerResult,
} from "./encode-snapshot.worker";
import type { ParquetWriter } from "./types";
import { resolveSnapshotByteLimit } from "../config";

export const writeParquetSnapshot: ParquetWriter = async (snapshot) => {
  const worker = new Worker(
    new URL("./encode-snapshot.worker.ts", import.meta.url),
  );

  const byteLimit = resolveSnapshotByteLimit();

  try {
    worker.postMessage({
      type: "config",
      columns: snapshot.columns,
    } satisfies SnapshotWorkerConfig);

    let inputBytes = 0;
    for await (const batch of snapshot.rows) {
      inputBytes += estimateBatchBytes(batch);
      if (inputBytes > byteLimit) {
        throw new Error(
          `Snapshot input exceeds the ${byteLimit}-byte encoding limit`,
        );
      }

      worker.postMessage({ type: "batch", rows: batch } satisfies SnapshotWorkerBatch);
      const [message] = await once(worker, "message") as [SnapshotWorkerResult];
      if (message.type !== "batch") throw new Error("Unexpected snapshot worker response");
      if (!message.ok) throw new Error(message.error);
    }

    worker.postMessage({ type: "encode" } satisfies SnapshotWorkerEncode);
    const [message] = await once(worker, "message") as [SnapshotWorkerResult];
    if (message.type !== "result") throw new Error("Unexpected snapshot worker response");
    if (!message.ok) throw new Error(message.error);
    return message.bytes;
  } finally {
    await worker.terminate();
  }
};

function estimateBatchBytes(rows: SnapshotWorkerBatch["rows"]): number {
  let bytes = rows.length * 16;
  for (const row of rows) {
    for (const value of row) {
      if (typeof value === "string") {
        bytes += Math.max(16, Buffer.byteLength(value), value.length * 2);
      } else {
        bytes += 16;
      }
    }
  }
  return bytes;
}
