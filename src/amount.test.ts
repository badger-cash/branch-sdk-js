import { describe, expect, it } from 'vitest';

import { AmountPrecisionError, formatAmount, parseAmount, toUnits } from './amount.js';

describe('reading NUMERIC(78,0) off the wire', () => {
  it('accepts the forms a node may send', () => {
    expect(toUnits(100, 'x')).toBe(100n);
    expect(toUnits('100', 'x')).toBe(100n);
    expect(toUnits(100n, 'x')).toBe(100n);
    // A decimal wrapper rather than a primitive.
    expect(toUnits({ toString: () => '100' }, 'x')).toBe(100n);
  });

  /**
   * The reason this module exists.
   *
   * NUMERIC(78,0) holds up to 78 digits. A JS number holds 15 to 16
   * significant ones, so for most of the column's range a number is not a
   * rounding risk to watch -- it is guaranteed loss.
   */
  it('carries a value far beyond what a number could hold', () => {
    const huge = '9'.repeat(78);
    expect(toUnits(huge, 'balance')).toBe(BigInt(huge));
    expect(toUnits(huge, 'balance').toString()).toHaveLength(78);
  });

  it('keeps the exact value at the boundary a number would round', () => {
    // 2^53 + 1. As a JS number this is indistinguishable from 2^53.
    expect(toUnits('9007199254740993', 'balance')).toBe(9007199254740993n);
    expect(Number('9007199254740993')).toBe(9007199254740992); // what we avoided
  });

  it('refuses a number that has already lost precision', () => {
    // If the value arrives as a number this large, the damage happened before
    // the SDK saw it. Returning it would hand back a balance that is wrong.
    // Computed rather than written: the literal itself cannot be spelled in
    // JS source without losing precision, which eslint's no-loss-of-precision
    // rightly refuses to let past. That is the same fact this test asserts.
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(Number.isSafeInteger(unsafe)).toBe(false);
    expect(() => toUnits(unsafe, 'balance')).toThrow(AmountPrecisionError);
    expect(() => toUnits(1e30, 'balance')).toThrow(/lost precision/);
  });

  it('refuses a fractional value rather than truncating it', () => {
    expect(() => toUnits(1.5, 'x')).toThrow(AmountPrecisionError);
    expect(() => toUnits('100.5', 'x')).toThrow(/fractional part/);
  });

  it('accepts an exact zero fraction, which is the same integer', () => {
    expect(toUnits('100.000', 'x')).toBe(100n);
  });

  it('rejects nonsense loudly', () => {
    expect(() => toUnits('abc', 'x')).toThrow(AmountPrecisionError);
    expect(() => toUnits(null, 'x')).toThrow(AmountPrecisionError);
    expect(() => toUnits({}, 'x')).toThrow(AmountPrecisionError);
  });
});

describe('formatAmount', () => {
  it('is the integer itself when the currency has no decimals', () => {
    // credits is configured with 0 decimals -- one credit is one dollar.
    expect(formatAmount({ units: 100n, decimals: 0 })).toBe('100');
  });

  it('places the point without going through a float', () => {
    expect(formatAmount({ units: 12345n, decimals: 2 })).toBe('123.45');
    expect(formatAmount({ units: 5n, decimals: 2 })).toBe('0.05');
    expect(formatAmount({ units: 0n, decimals: 2 })).toBe('0.00');
    expect(formatAmount({ units: -12345n, decimals: 2 })).toBe('-123.45');
  });

  it('formats a value no float could represent', () => {
    const units = BigInt('123456789012345678901234567890');
    expect(formatAmount({ units, decimals: 2 })).toBe('1234567890123456789012345678.90');
  });
});

describe('parseAmount', () => {
  it('round-trips with formatAmount', () => {
    for (const text of ['0.00', '1.00', '123.45', '0.05', '-123.45']) {
      expect(formatAmount(parseAmount(text, 2))).toBe(text);
    }
  });

  it('takes the shapes a form produces', () => {
    expect(parseAmount('1', 2).units).toBe(100n);
    expect(parseAmount('1.5', 2).units).toBe(150n);
    expect(parseAmount('.5', 2).units).toBe(50n);
    expect(parseAmount(' 12 ', 0).units).toBe(12n);
  });

  it('never routes through a float', () => {
    // parseFloat('0.1') * 100 is 10.000000000000002, which is the entire
    // reason this function exists rather than a multiply.
    expect(parseAmount('0.1', 2).units).toBe(10n);
    expect(parseAmount('1234567890123456789.99', 2).units).toBe(123456789012345678999n);
  });

  it('refuses more decimal places than the currency has', () => {
    expect(() => parseAmount('1.005', 2)).toThrow(/decimal places/);
    expect(() => parseAmount('1.5', 0)).toThrow(/decimal places/);
  });

  it('refuses input that is not a number', () => {
    expect(() => parseAmount('', 2)).toThrow(AmountPrecisionError);
    expect(() => parseAmount('abc', 2)).toThrow(AmountPrecisionError);
    expect(() => parseAmount('1.2.3', 2)).toThrow(AmountPrecisionError);
  });
});
