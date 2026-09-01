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

/** Render an amount for display, without going through a float. */
export function formatAmount(amount: CreditAmount): string {
  const { units, decimals } = amount;
  if (decimals === 0) return units.toString();

  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
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
