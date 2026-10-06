import { BranchError } from './errors.js';

/*
  Row and parameter coercion shared by every client in this package.

  EXTRACTED FROM THE DELETED listings.ts RATHER THAN COPIED, because `tokens.ts`
  needed the same three and a second copy of `asQueryInt` is a second place for
  the MAX_SAFE_INTEGER check to be forgotten. Nothing here is new behaviour.

  DELIBERATELY NOT EXPORTED. A consumer that needs these should own its own copy
  rather than depend on this package's internals -- which is what
  island-nook-directory-45 does in `src/lib/cars.ts`.
*/

/**
 * An INT8 parameter, checked.
 *
 * `selectQuery` cannot declare types at all, so an INT8 has to cross as a
 * number -- which silently loses precision past 2^53. A chain id is small today
 * and the check costs nothing, so it fails loudly here rather than returning
 * the wrong record much later.
 */
export function asQueryInt(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BranchError(
      `${value.toString()} is past Number.MAX_SAFE_INTEGER and cannot be bound without losing precision`
    );
  }
  return Number(value);
}

/** A page size: 50 by default, 200 at most. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BranchError(`limit must be a positive integer, received ${String(limit)}`);
  }
  return Math.min(limit, 200);
}

export function asText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new BranchError(`expected text for ${field}, received ${typeof value}`);
  }
  return value;
}

/**
 * A decimal bound or value, as the string the action casts.
 *
 * VALIDATED HERE BECAUSE THE ALTERNATIVE IS A PLANNER ERROR. An unvalidated
 * bound reaches the action, fails its `::NUMERIC(38,10)` cast, and comes back as
 * a cast error from the query planner -- so a caller who typed a price wrong
 * learns it from the database rather than from the parameter they got wrong.
 */
export function decimalText(value: string | number, field: string): string {
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new BranchError(`${field} must be a decimal number, not ${JSON.stringify(value)}`);
  }
  return text;
}
