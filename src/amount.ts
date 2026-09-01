import { BranchError } from './errors.js';

/**
 * A currency amount, exactly.
 *
 * `currency_entries.amount` and `currency_balances.amount` are
 * `NUMERIC(78,0)` -- an integer of up to 78 digits. A JS `number` holds 15 to
 * 16 significant digits, so representing one as a number is not a rounding
 * risk to be watched, it is a guaranteed loss of information for most of the
 * range the column allows.
 *
 * So the value is a `bigint` and never a `number`. `decimals` comes from
 * `currencies.decimals` and says only how to *display* it; the scale of the
 * column itself is 0, so `units` is always a whole number. `credits` is
 * configured with 0 decimals -- one credit is one dollar -- but nothing here
 * assumes that, because the same ledger carries every currency.
 */
export interface CreditAmount {
  /** The raw integer, in the currency's smallest unit. */
  readonly units: bigint;
  /** Digits after the decimal point when displaying. */
  readonly decimals: number;
}

/** Thrown when an amount cannot be represented without losing information. */
export class AmountPrecisionError extends BranchError {}

/**
 * Read an amount off a node response.
 *
 * A `number` is accepted only when it is a safe integer. Beyond that the
 * damage has already happened upstream -- the value was rounded before this
 * code saw it -- and returning it would hand back a balance that is quietly
 * wrong. Failing is the only honest option, and it is loud enough to find.
 */
export function toUnits(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new AmountPrecisionError(`${field} arrived as a non-integer number (${String(value)})`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new AmountPrecisionError(
        `${field} arrived as the number ${String(value)}, which is past Number.MAX_SAFE_INTEGER ` +
          'and has already lost precision before reaching the SDK'
      );
    }
    return BigInt(value);
  }

  if (typeof value === 'string') return parseInteger(value, field);

  // kwil may hand back a decimal wrapper rather than a primitive.
  if (typeof value === 'object' && value !== null) {
    const text = (value as { toString: () => string }).toString();
    if (text !== '[object Object]') return parseInteger(text, field);
  }

  throw new AmountPrecisionError(`${field} arrived as ${typeof value}, which is not a number`);
}

function parseInteger(text: string, field: string): bigint {
  const trimmed = text.trim();
  // NUMERIC(78,0) has scale 0, but a source that formats it may still append
  // a zero fraction. '100.000' is exact; '100.5' is not, and silently
  // truncating it would be the same failure this module exists to prevent.
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new AmountPrecisionError(`${field} is not a decimal integer: ${JSON.stringify(text)}`);
  }
  const [, whole, fraction] = match;
  if (fraction !== undefined && /[1-9]/.test(fraction)) {
    throw new AmountPrecisionError(`${field} has a fractional part that would be lost: ${trimmed}`);
  }
  return BigInt(whole ?? '0');
}

export interface FormatOptions {
  /**
   * Drop trailing zeros in the fraction, and the point if nothing survives.
   *
   * A listing price is NUMERIC(38,10), so an exact rendering of $12,750 is
   * '12750.0000000000'. That is correct and unreadable. Trimming is a display
   * choice and never changes the value, which stays a bigint either way.
   */
  trim?: boolean;
}

/**
 * Read a scaled NUMERIC off the wire.
 *
 * The distinction from `toUnits` is easy to get wrong and I got it wrong: a
 * NUMERIC arrives as a decimal string of the VALUE, not as pre-scaled integer
 * units. NUMERIC(78,0) has scale 0, so for a credit balance the two are the
 * same number and `toUnits` is right. NUMERIC(38,10) does not: a price of
 * 12750 arrives as '12750', and treating that as scale-10 units renders it as
 * 0.000001275.
 *
 * So the text is parsed at the column's scale instead.
 */
export function toAmount(value: unknown, decimals: number, field: string): CreditAmount {
  if (decimals === 0) return { units: toUnits(value, field), decimals };

  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'object' && value !== null) {
    text = (value as { toString: () => string }).toString();
    if (text === '[object Object]') {
      throw new AmountPrecisionError(`${field} is not a number: ${JSON.stringify(value)}`);
    }
  } else {
    throw new AmountPrecisionError(`${field} arrived as ${typeof value}, which is not a number`);
  }

  return parseAmount(text, decimals);
}

/** Render an amount for display, without going through a float. */
export function formatAmount(amount: CreditAmount, options: FormatOptions = {}): string {
  const { units, decimals } = amount;
  if (decimals === 0) return units.toString();

  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  let fraction = digits.slice(digits.length - decimals);

  if (options.trim === true) {
    fraction = fraction.replace(/0+$/, '');
    if (fraction === '') return `${negative ? '-' : ''}${whole}`;
  }
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Parse a typed amount, e.g. from a purchase form.
 *
 * String in, bigint out, with no float step -- `parseFloat('0.1') * 100` is
 * 10.000000000000002, and that is the whole reason this exists.
 */
export function parseAmount(text: string, decimals: number): CreditAmount {
  const trimmed = text.trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new AmountPrecisionError(`not a number: ${JSON.stringify(text)}`);
  }
  const [, sign, whole = '', fraction = ''] = match;

  if (fraction.length > decimals) {
    throw new AmountPrecisionError(
      `${trimmed} has ${String(fraction.length)} decimal places but this currency allows ${String(decimals)}`
    );
  }

  const units = BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0')}`);
  return { units: sign === '-' ? -units : units, decimals };
}
