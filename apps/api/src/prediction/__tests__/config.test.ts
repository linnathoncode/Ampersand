import { describe, expect, test } from "bun:test";

import { getBoundaryWarningRatio } from "../config";

describe("prediction configuration", () => {
  test("uses the default boundary warning ratio", () => {
    expect(getBoundaryWarningRatio(undefined)).toBe(0.1);
  });

  test("parses a configured boundary warning ratio", () => {
    expect(getBoundaryWarningRatio("0.2")).toBe(0.2);
  });

  test("rejects an invalid boundary warning ratio", () => {
    expect(() => getBoundaryWarningRatio("invalid")).toThrow();
    expect(() => getBoundaryWarningRatio("-0.1")).toThrow();
    expect(() => getBoundaryWarningRatio("0.6")).toThrow();
  });
});
