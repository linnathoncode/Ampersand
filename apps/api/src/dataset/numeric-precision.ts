export class NumericPrecisionLossError extends Error {
  constructor(
    public readonly columnName: string,
    public readonly value: string,
  ) {
    super(
      `Value '${value}' in column '${columnName}' cannot be stored as a float64 without losing precision`,
    );
    this.name = "NumericPrecisionLossError";
  }
}

const DECIMAL_PATTERN = /^\d*(?:\.\d*)?(?:[eE][+-]?\d+)?$/;
const EXPONENT_NOTATION = /[eE][+-]?\d+$/;

/**
 * Maximum significant decimal digits a float64 is guaranteed to round-trip.
 * Values with more digits than this are only accepted when they are exactly
 * representable as a float64 (for example powers of ten below 2^53).
 */
const FLOAT64_SIGNIFICANT_DIGITS = 15;

type Rational = { num: bigint; den: bigint };

/**
 * Returns true when the value can be frozen as a float64 without losing the
 * digits a float64 can represent. Arbitrary-precision `numeric` columns arrive
 * as decimal strings; any value with more significant digits than a float64
 * mantissa can hold (for example `numeric(38,0)` identifiers) is rejected
 * instead of being silently rounded.
 */
export function isFloat64LosslessDecimal(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;

  const value = String(raw);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return false;

  const decimal = parseDecimalRational(value);
  if (!decimal) return false;

  if (parsed === 0) return decimal.num === 0n;

  if (rationalEqual(decimal, doubleExactFraction(parsed))) return true;

  return countSignificantDigits(value) <= FLOAT64_SIGNIFICANT_DIGITS;
}

function parseDecimalRational(value: string): Rational | null {
  let body = value.trim();
  let negative = false;
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }

  let exponent = 0n;
  const exponentIndex = body.search(EXPONENT_NOTATION);
  if (exponentIndex !== -1) {
    exponent = BigInt(body.slice(exponentIndex + 1));
    body = body.slice(0, exponentIndex);
  }

  const dotIndex = body.indexOf(".");
  const digits = dotIndex === -1 ? body : body.slice(0, dotIndex) + body.slice(dotIndex + 1);
  if (digits.length === 0 || !/^\d*$/.test(digits)) return null;

  const fractionLength = dotIndex === -1 ? 0n : BigInt(body.length - 1 - dotIndex);
  const coefficient = BigInt(digits);
  if (coefficient === 0n) return { num: 0n, den: 1n };

  const scale10 = exponent - fractionLength;
  const signed = negative ? -coefficient : coefficient;
  if (scale10 >= 0n) {
    return { num: signed * 10n ** scale10, den: 1n };
  }
  return { num: signed, den: 10n ** -scale10 };
}

function doubleExactFraction(value: number): Rational {
  if (value === 0) return { num: 0n, den: 1n };

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);

  const high = view.getUint32(0, false);
  const low = view.getUint32(4, false);
  const exponentBits = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);

  let mantissa: bigint;
  let exponent2: bigint;
  if (exponentBits === 0) {
    mantissa = fraction;
    exponent2 = -1074n;
  } else {
    mantissa = fraction | (1n << 52n);
    exponent2 = BigInt(exponentBits) - 1075n;
  }

  const signed = high >>> 31 ? -mantissa : mantissa;
  if (exponent2 >= 0n) return { num: signed << exponent2, den: 1n };
  return { num: signed, den: 1n << -exponent2 };
}

function rationalEqual(left: Rational, right: Rational): boolean {
  return left.num * right.den === right.num * left.den;
}

function countSignificantDigits(value: string): number {
  let body = value.trim().toLowerCase();
  if (body.startsWith("-") || body.startsWith("+")) body = body.slice(1);
  const exponentIndex = body.search(/e/);
  if (exponentIndex !== -1) body = body.slice(0, exponentIndex);

  const dotIndex = body.indexOf(".");
  const integerPart = dotIndex === -1 ? body : body.slice(0, dotIndex);
  const fractionPart = dotIndex === -1 ? "" : body.slice(dotIndex + 1);

  const integerDigits = integerPart.replace(/^0+/, "");
  const fractionSignificant = fractionPart
    .replace(/^0+/, "")
    .replace(/0+$/, "");

  return integerDigits.length + fractionSignificant.length;
}
