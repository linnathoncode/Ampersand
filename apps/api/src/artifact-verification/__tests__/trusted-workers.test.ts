import { describe, expect, test } from "bun:test";

import { parseTrustedWorkerIds } from "../trusted-workers";

describe("trusted worker configuration", () => {
  test("fails closed when configuration is missing", () => {
    expect([...parseTrustedWorkerIds(undefined)]).toEqual([]);
  });

  test("trims worker IDs, removes blanks, and deduplicates values", () => {
    expect([
      ...parseTrustedWorkerIds(" worker-1,worker-2,,worker-1 "),
    ]).toEqual(["worker-1", "worker-2"]);
  });
});
