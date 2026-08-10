import { describe, expect, test } from "bun:test";

import { isFloat64LosslessDecimal } from "./numeric-precision";

describe("isFloat64LosslessDecimal", () => {
  test("accepts integers and exactly representable decimals", () => {
    expect(isFloat64LosslessDecimal("100")).toBe(true);
    expect(isFloat64LosslessDecimal("100.00")).toBe(true);
    expect(isFloat64LosslessDecimal("-12.5")).toBe(true);
    expect(isFloat64LosslessDecimal("0")).toBe(true);
    expect(isFloat64LosslessDecimal("0.000")).toBe(true);
    expect(isFloat64LosslessDecimal("0.5")).toBe(true);
    expect(isFloat64LosslessDecimal("0.75")).toBe(true);
    expect(isFloat64LosslessDecimal("1.5")).toBe(true);
    expect(isFloat64LosslessDecimal("9007199254740992")).toBe(true);
    expect(isFloat64LosslessDecimal("18014398509481984")).toBe(true);
    expect(isFloat64LosslessDecimal("10000000000000000000000")).toBe(true);
    expect(isFloat64LosslessDecimal(null)).toBe(true);
    expect(isFloat64LosslessDecimal(undefined)).toBe(true);
  });

  test("accepts common decimal fractions within float64 precision", () => {
    expect(isFloat64LosslessDecimal("0.1")).toBe(true);
    expect(isFloat64LosslessDecimal("123.456")).toBe(true);
    expect(isFloat64LosslessDecimal("99.99")).toBe(true);
    expect(isFloat64LosslessDecimal("0.500000000000001")).toBe(true);
    expect(isFloat64LosslessDecimal("1e-20")).toBe(true);
    expect(isFloat64LosslessDecimal("1e-300")).toBe(true);
    expect(isFloat64LosslessDecimal("0.0001234567890123")).toBe(true);
    expect(isFloat64LosslessDecimal("-0.123456789012345")).toBe(true);
    expect(isFloat64LosslessDecimal("+0.123456789012345")).toBe(true);
  });

  test("rejects values that exceed float64 precision", () => {
    expect(isFloat64LosslessDecimal("123456789012345678901234567890")).toBe(false);
    expect(isFloat64LosslessDecimal("-123456789012345678901234567890")).toBe(false);
    expect(isFloat64LosslessDecimal("10000000000000000000000000000000000000")).toBe(false);
    expect(isFloat64LosslessDecimal("9007199254740993")).toBe(false);
    expect(isFloat64LosslessDecimal("1234567890.123456")).toBe(false);
    expect(isFloat64LosslessDecimal("9.9999999999999999")).toBe(false);
    expect(isFloat64LosslessDecimal("1e+400")).toBe(false);
    expect(isFloat64LosslessDecimal("1e-400")).toBe(false);
  });

  test("rejects values that underflow to zero", () => {
    expect(isFloat64LosslessDecimal("1e-324")).toBe(false);
    expect(isFloat64LosslessDecimal("2e-324")).toBe(false);
  });
});
