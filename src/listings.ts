import { toAmount, toUnits } from './amount.js';
import { numeric } from './client.js';
import { BranchError } from './errors.js';

import type { CreditAmount } from './amount.js';
import type { BranchClient } from './client.js';

/** `value_number` is NUMERIC(38,10); prices and mileage carry that scale. */
export const LISTING_SCALE = 10;

/** How a listing ended. Mirrors what `close_listing` accepts. */
export type ListingOutcome = 'sold' | 'withdrawn';

/** A listing as it appears in a browse or search result. */
export interface ListingSummary {
  listingId: bigint;
  title: string;
  make: string;
  model: string;
  year: number;
  price: CreditAmount;
  currency: string;
  location: string;
  listedAt: Date;
}

/** Everything on one advertisement. */
export interface Listing extends ListingSummary {
  state: string;
  seller: string;
  mileage: bigint;
  vin: string;
  description: string;
  /** URLs, as `create_listing` received them. */
  photos: string[];
  /** The custodian holding the seller's contact details, never the details. */
  contactVia: string;
}

/** One of the seller's own listings, in any state. */
export interface OwnListing {
  listingId: bigint;
  title: string;
  state: string;
  listedAt: Date;
}

/**
 * A page key that survives listings sharing a timestamp.
 *
 * `created_at` is `@block_timestamp`, so everything minted in one block has the
 * same value. Paging on it alone repeats or skips rows; the id is the
 * tiebreaker that makes it deterministic, and the browse index
 * `(token_class_id, current_state_id, created_at, id)` is ordered to serve
 * exactly this.
 */
export interface PageCursor {
  listedAt: Date;
  listingId: bigint;
}

export interface BrowseOptions {
  limit?: number;
  /** Continue after this row. Omit for the first page. */
  after?: PageCursor;
}

export interface SearchOptions extends BrowseOptions {
  /** Matched case-insensitively; folded to lower on the way in. */
  make?: string;
  model?: string;
  /** Inclusive. */
  yearFrom?: number;
  yearTo?: number;
  /** Inclusive ceiling, as a decimal string or a number. */
  maxPrice?: string | number;
}

export interface CreateListingInput {
  make: string;
  model: string;
  year: number;
  /** Decimal string preferred; a number is accepted for convenience. */
  price: string | number;
  priceCurrency: string;
  durationDays: number;
  location: string;
  /**
   * The commitment, from the custodian. Never the seller's contact details:
   * every validator holds every row permanently and reads are unauthenticated,
   * so the plaintext stays off-chain by design.
   */
  contactHmacHex: string;
  vin: string;
  mileage: string | number;
  description: string;
  photos?: string[];
}

interface SummaryRow {
  id: unknown;
  name: unknown;
  created_at: unknown;
  make: unknown;
  model: unknown;
  year: unknown;
  price: unknown;
  currency: unknown;
  location: unknown;
}

interface DetailRow {
  listing_id: unknown;
  title: unknown;
  state: unknown;
  seller: unknown;
  make: unknown;
  model: unknown;
  year: unknown;
  price: unknown;
  currency: unknown;
  location: unknown;
  mileage: unknown;
  vin: unknown;
  description: unknown;
  photos: unknown;
  contact_via: unknown;
  listed_at: unknown;
}

interface OwnRow {
  id: unknown;
  name: unknown;
  created_at: unknown;
  state: unknown;
}

/**
 * Publishing, closing, and every read path a buyer uses.
 *
 * Writes go through actions, which is where the fee, the VIN guard and the
 * expiry stamp live. Reads are plain SELECTs: decision 2b leaves `SELECT`
 * granted, so the entire browse and search surface needs no server-side code.
 */
export class ListingsClient {
  constructor(private readonly client: BranchClient) {}

  /**
   * Publish a listing and pay the fee for its duration.
   *
   * `make`, `model` and `vin` are folded to lower case by the action on write,
   * so searches stay bare equalities on `metadata_lookup_idx`. The display
   * spelling is not lost -- `tokens.name` keeps the seller's own wording.
   */
  async create(input: CreateListingInput): Promise<string> {
    return await this.client.write(
      'create_listing',
      {
        $make: input.make,
        $model: input.model,
        $year: input.year,
        $price: decimalString(input.price, 'price'),
        $price_currency: input.priceCurrency,
        $duration_days: input.durationDays,
        $location: input.location,
        $contact_hmac_hex: input.contactHmacHex,
        $vin: input.vin,
        $mileage: decimalString(input.mileage, 'mileage'),
        $description: input.description,
        $photos_json: JSON.stringify(input.photos ?? []),
      },
      // Nothing infers to NUMERIC: a string infers text and a number int8, and
      // the action refuses both. Both numeric parameters have to be declared.
      { $price: numeric(38, 10), $mileage: numeric(38, 10) }
    );
  }

  /** End a listing. `sold` and `withdrawn` are the only outcomes. */
  async close(listingId: bigint | number, outcome: ListingOutcome): Promise<string> {
    return await this.client.write('close_listing', {
      $token_id: asActionInt(listingId),
      $outcome: outcome,
    });
  }

  /** One advertisement, in full. Null when nothing has that id. */
  async get(listingId: bigint | number): Promise<Listing | null> {
    const rows = await this.client.read<DetailRow>('get_listing', {
      $token_id: asActionInt(listingId),
    });
    const row = rows[0];
    if (!row) return null;

    return {
      listingId: toUnits(row.listing_id, 'listing_id'),
      title: asText(row.title, 'title'),
      state: asText(row.state, 'state'),
      seller: asText(row.seller, 'seller'),
      make: asText(row.make, 'make'),
      model: asText(row.model, 'model'),
      year: Number(toUnits(row.year, 'year')),
      price: toAmount(row.price, LISTING_SCALE, 'price'),
      currency: asText(row.currency, 'currency'),
      location: asText(row.location, 'location'),
      mileage: toUnits(row.mileage, 'mileage'),
      vin: asText(row.vin, 'vin'),
      description: asText(row.description, 'description'),
      photos: parsePhotos(row.photos),
      contactVia: asText(row.contact_via, 'contact_via'),
      listedAt: toDate(row.listed_at),
    };
  }

  /** Active listings, newest first. */
  async browse(options: BrowseOptions = {}): Promise<ListingSummary[]> {
    return await this.search(options);
  }

  /**
   * Active listings with optional facets.
   *
   * Each facet is one join against `metadata`. Text predicates ride
   * `metadata_lookup_idx (identifier, value_text)` and numeric ranges ride
   * `metadata_number_idx (identifier, value_number)`, which exists because
   * half of any car search is ranges and the text index cannot serve them.
   *
   * A join per predicate is comfortable at three or four. If the product grows
   * to a dozen facets this wants revisiting rather than more joins.
   */
  async search(options: SearchOptions = {}): Promise<ListingSummary[]> {
    const limit = clampLimit(options.limit);
    const joins: string[] = [];
    const where: string[] = [];
    const params: Record<string, unknown> = { $take: limit };

    if (options.make !== undefined) {
      // Folded, not lower()ed in SQL. create_listing folds on write, so a bare
      // equality stays on the index; lower(value_text) here would scan every
      // row, because kwil has no expression indexes.
      params.$make = options.make.trim().toLowerCase();
      joins.push(
        `JOIN metadata mk ON mk.entity_type = 'token' AND mk.entity_id = t.id
                         AND mk.identifier = 'make' AND mk.value_text = $make
                         AND mk.deleted_at IS NULL`
      );
    }
    if (options.model !== undefined) {
      params.$model = options.model.trim().toLowerCase();
      joins.push(
        `JOIN metadata mo ON mo.entity_type = 'token' AND mo.entity_id = t.id
                         AND mo.identifier = 'model' AND mo.value_text = $model
                         AND mo.deleted_at IS NULL`
      );
    }

    const yearBounds: string[] = [];
    if (options.yearFrom !== undefined) {
      yearBounds.push(`my.value_number >= ${numericLiteral(options.yearFrom, 'yearFrom')}`);
    }
    if (options.yearTo !== undefined) {
      yearBounds.push(`my.value_number <= ${numericLiteral(options.yearTo, 'yearTo')}`);
    }
    if (yearBounds.length > 0) {
      joins.push(
        `JOIN metadata my ON my.entity_type = 'token' AND my.entity_id = t.id
                         AND my.identifier = 'year' AND my.deleted_at IS NULL
                         AND ${yearBounds.join(' AND ')}`
      );
    }

    if (options.maxPrice !== undefined) {
      joins.push(
        `JOIN metadata mp ON mp.entity_type = 'token' AND mp.entity_id = t.id
                         AND mp.identifier = 'price' AND mp.deleted_at IS NULL
                         AND mp.value_number <= ${numericLiteral(options.maxPrice, 'maxPrice')}`
      );
    }

    if (options.after) {
      // Strictly after the cursor in the same order the index provides.
      params.$after_at = asQueryInt(BigInt(Math.floor(options.after.listedAt.getTime() / 1000)));
      params.$after_id = asQueryInt(options.after.listingId);
      where.push('(t.created_at < $after_at OR (t.created_at = $after_at AND t.id < $after_id))');
    }

    const rows = await this.client.query<SummaryRow>(
      `SELECT t.id, t.name, t.created_at,
              mkv.value_text  AS make,
              mov.value_text  AS model,
              myv.value_number AS year,
              mpv.value_number AS price,
              mcv.value_text  AS currency,
              mlv.value_text  AS location
         FROM tokens t
         ${joins.join('\n         ')}
         LEFT JOIN metadata mkv ON mkv.entity_type = 'token' AND mkv.entity_id = t.id
                               AND mkv.identifier = 'make' AND mkv.deleted_at IS NULL
         LEFT JOIN metadata mov ON mov.entity_type = 'token' AND mov.entity_id = t.id
                               AND mov.identifier = 'model' AND mov.deleted_at IS NULL
         LEFT JOIN metadata myv ON myv.entity_type = 'token' AND myv.entity_id = t.id
                               AND myv.identifier = 'year' AND myv.deleted_at IS NULL
         LEFT JOIN metadata mpv ON mpv.entity_type = 'token' AND mpv.entity_id = t.id
                               AND mpv.identifier = 'price' AND mpv.deleted_at IS NULL
         LEFT JOIN metadata mcv ON mcv.entity_type = 'token' AND mcv.entity_id = t.id
                               AND mcv.identifier = 'price_currency' AND mcv.deleted_at IS NULL
         LEFT JOIN metadata mlv ON mlv.entity_type = 'token' AND mlv.entity_id = t.id
                               AND mlv.identifier = 'location' AND mlv.deleted_at IS NULL
         LEFT JOIN metadata mev ON mev.entity_type = 'token' AND mev.entity_id = t.id
                               AND mev.identifier = 'expires_at' AND mev.deleted_at IS NULL
        WHERE t.token_class_id = $class_id
          AND t.current_state_id = $active
          AND t.deleted_at IS NULL
          AND (mev.value_datetime IS NULL OR mev.value_datetime > $now)
          ${where.length > 0 ? `AND ${where.join(' AND ')}` : ''}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $take`,
      { ...params, ...(await this.classAndState()), $now: Math.floor(Date.now() / 1000) }
    );

    return rows.map((row) => this.toSummary(row));
  }

  /**
   * The caller's own listings, in every state.
   *
   * Not filtered to active: a seller needs to see what they withdrew, sold, or
   * let expire. Resolved through `person_keys` on the canonical address, which
   * is the lookup that fails open if it is not normalised.
   */
  async mine(options: { limit?: number } = {}): Promise<OwnListing[]> {
    const rows = await this.client.query<OwnRow>(
      `SELECT t.id, t.name, t.created_at, s.name AS state
         FROM tokens t
         JOIN token_class_states s ON s.id = t.current_state_id
         JOIN person_keys k        ON k.person_id = t.issuer_person_id
        WHERE t.token_class_id = $class_id
          AND k.address = $address
          AND k.confirmed_at IS NOT NULL
          AND k.revoked_at IS NULL
          AND t.deleted_at IS NULL
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT $take`,
      {
        $class_id: (await this.classAndState()).$class_id,
        $address: this.client.address,
        $take: clampLimit(options.limit),
      }
    );

    return rows.map((row) => ({
      listingId: toUnits(row.id, 'id'),
      title: asText(row.name, 'name'),
      state: asText(row.state, 'state'),
      listedAt: toDate(row.created_at),
    }));
  }

  private toSummary(row: SummaryRow): ListingSummary {
    return {
      listingId: toUnits(row.id, 'id'),
      title: asText(row.name, 'name'),
      make: asText(row.make, 'make'),
      model: asText(row.model, 'model'),
      year: Number(toUnits(row.year, 'year')),
      price: toAmount(row.price, LISTING_SCALE, 'price'),
      currency: asText(row.currency, 'currency'),
      location: asText(row.location, 'location'),
      listedAt: toDate(row.created_at),
    };
  }

  /** Resolve the automobile class and its active state, once per call. */
  private async classAndState(): Promise<{ $class_id: number; $active: number }> {
    if (this.cachedClass) return this.cachedClass;
    const rows = await this.client.query<{ class_id: unknown; state_id: unknown }>(
      `SELECT c.id AS class_id, s.id AS state_id
         FROM token_classes c
         JOIN token_class_states s ON s.token_class_id = c.id AND s.name = 'active'
        WHERE c.slug = 'automobile-listing' AND c.deleted_at IS NULL
        LIMIT 1`
    );
    const row = rows[0];
    if (!row) {
      throw new BranchError('the automobile-listing class is not configured on this chain');
    }
    this.cachedClass = {
      $class_id: asQueryInt(toUnits(row.class_id, 'class_id')),
      $active: asQueryInt(toUnits(row.state_id, 'state_id')),
    };
    return this.cachedClass;
  }

  private cachedClass: { $class_id: number; $active: number } | undefined;
}

/**
 * A NUMERIC bound written into the SQL rather than bound as a parameter.
 *
 * `selectQuery` cannot declare parameter types -- unlike `execute`, which takes
 * a `types` map -- so kwil infers from the JavaScript value and nothing infers
 * to NUMERIC. A number becomes int8 and a string becomes text, and the planner
 * refuses both against a NUMERIC(38,10) column: "comparison operands must be
 * of the same type". Writing `$year::NUMERIC(38,10)` does not help either; the
 * cast is lost before Postgres sees the statement.
 *
 * Casting the column instead would work and would take every browse off
 * `metadata_number_idx`, since kwil has no expression indexes.
 *
 * So the literal is inlined -- but only after being matched against a strict
 * decimal pattern, so nothing but digits, one dot and a leading minus can ever
 * reach the statement. That is a whitelist, not an escape, which is what makes
 * it safe rather than merely careful.
 */
function numericLiteral(value: string | number, field: string): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new BranchError(`${field} must be a decimal number, received ${JSON.stringify(value)}`);
  }
  return `${text}::NUMERIC(38,10)`;
}

/** A decimal for an action parameter, where the type can be declared. */
function decimalString(value: string | number, field: string): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new BranchError(`${field} must be a decimal number, received ${JSON.stringify(value)}`);
  }
  return text;
}

function asActionInt(value: bigint | number): number {
  const asBig = typeof value === 'bigint' ? value : BigInt(value);
  return asQueryInt(asBig);
}

/** See the note in credits.ts: an INT8 has to cross as a checked number. */
function asQueryInt(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BranchError(
      `${value.toString()} is past Number.MAX_SAFE_INTEGER and cannot be bound without losing precision`
    );
  }
  return Number(value);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BranchError(`limit must be a positive integer, received ${String(limit)}`);
  }
  return Math.min(limit, 200);
}

function asText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new BranchError(`expected text for ${field}, received ${typeof value}`);
  }
  return value;
}

function toDate(value: unknown): Date {
  return new Date(Number(toUnits(value, 'timestamp')) * 1000);
}

/** `photos` is one metadata row holding a JSON array, because an identifier
 * cannot repeat on one entity. */
function parsePhotos(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
