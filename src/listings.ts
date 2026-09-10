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

  /**
   * Open to offers, and open to a trade. On the SUMMARY, deliberately.
   *
   * These two earn a place in the browse projection where the six descriptors
   * do not, because they change how a price reads. "$18,000" and "$18,000 or
   * best offer" are different offers, and a buyer scanning a grid decides which
   * cards to open on exactly that. Body style and fuel type are things you look
   * up once you have opened one.
   *
   * Two more LEFT JOINs on a query that already carries seven. Worth it here,
   * and worth NOT repeating for every future optional field.
   *
   * THREE STATES, NOT TWO. `false` is a seller who was asked and declined;
   * `null` is a seller who was never shown the question. Rendering null as
   * "no" attributes a refusal to somebody who did not make one -- and every
   * listing published before this field existed is null, permanently.
   */
  acceptsOffers: boolean | null;
  acceptsTrade: boolean | null;

  /**
   * The listing's photographs, as URLs.
   *
   * ON THE SUMMARY, because a classifieds grid without photographs is not a
   * classifieds grid. This was omitted at first on the reasoning that browse
   * should stay cheap and photos were a detail-page concern -- and the result
   * was a wall of placeholder icons, which is the one thing a car marketplace
   * cannot ship. The picture IS the listing on a card; the words are the
   * caption.
   *
   * One more LEFT JOIN, and it buys more than the other nine put together.
   *
   * Empty for a listing published without any, which stays common: photos are
   * optional and every listing made before the upload pipeline existed has
   * none. A caller still needs a placeholder.
   */
  photos: string[];
}

/** Everything on one advertisement. */
export interface Listing extends ListingSummary {
  state: string;
  seller: string;
  mileage: bigint;
  vin: string;
  description: string;
  /** The custodian holding the seller's contact details, never the details. */
  contactVia: string;

  /*
    The optional descriptors, as the chain stores them: FOLDED. `displayCase`
    in the app is what puts a capital letter back — doing it here would make
    the value read back differ from the value a filter must be given, which is
    the kind of asymmetry that produces a search box finding nothing.

    Null means the seller said nothing, and every consumer has to handle it:
    six of these were declared for months before anything could write them, so
    every listing published before then has null for all of them, permanently.
  */
  bodyStyle: string | null;
  transmission: string | null;
  fuelType: string | null;
  exteriorColor: string | null;
  condition: string | null;
  titleStatus: string | null;

  // acceptsOffers and acceptsTrade are inherited: they are on the summary
  // because a card needs them, and a detail view is a summary with more.
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

/**
 * What publishing costs for one of the durations the chain sells.
 *
 * THE TIERS ARE DATA, NOT CONSTANTS. Each rate is a `metadata` row on the
 * automobile token class -- `fee_30d`, `fee_180d` -- precisely so the admin
 * office can reprice by transaction instead of by redeploy. A client that
 * hardcodes "30 days costs 1 credit" is a client that shows the wrong price
 * the day after a repricing, and the ledger is the only place that would
 * disagree with it.
 *
 * The set of tiers is discovered the same way, so a third one appears in a
 * seller's choices without touching this package. Introducing a tier still
 * takes a `metadata_schemas` declaration on chain, which is deliberate:
 * repricing is configuration, adding a price point is a product decision.
 */
export interface FeeTier {
  /** Days the listing stays active. `create_listing` takes this. */
  readonly durationDays: number;
  /**
   * The charge, in whole credits, as `listing_fee` computes it.
   *
   * SCALE 0, NOT 10, and the difference is the whole reason this is not a
   * bare read of the column. The stored rate is `NUMERIC(38,10)`, but
   * `listing_fee` returns `NUMERIC(78,0)` and the ledger it is charged
   * against has scale 0 -- so the credited amount is the rate rounded, and
   * that rounded figure is what a seller must be shown and what their balance
   * must be compared against. Handing back the scale-10 column would produce
   * `units` a thousand million times larger than a balance's, and the
   * comparison would silently pass on an empty account.
   */
  readonly fee: CreditAmount;
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

  /*
    THE OPTIONAL DESCRIPTORS. Omitting one writes no row, which is not the same
    as writing an empty one: a filter can exclude a listing that says nothing,
    and cannot recover a listing that said "" as though it were an answer.

    All six fold to lower on the chain, so the value read back is not the value
    written. `displayCase` in the app is what puts a capital letter back.
  */
  bodyStyle?: string;
  transmission?: string;
  fuelType?: string;
  exteriorColor?: string;
  condition?: string;
  /** Clean, salvage, rebuilt. The disclosure a used-car buyer wants most. */
  titleStatus?: string;

  /**
   * Open to offers, and open to a trade.
   *
   * `undefined` means the seller was never asked and writes no row. `false`
   * means they were asked and declined, and writes one. Collapsing the two
   * would tell a buyer somebody refused them when nobody was asked.
   *
   * Neither is a price. A car listed at 18000 OBO is still 18000 for filtering
   * and ordering, with a flag beside it.
   */
  acceptsOffers?: boolean;
  acceptsTrade?: boolean;
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
  accepts_offers: unknown;
  accepts_trade: unknown;
  photos: unknown;
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
  body_style: unknown;
  transmission: unknown;
  fuel_type: unknown;
  exterior_color: unknown;
  condition: unknown;
  title_status: unknown;
  accepts_offers: unknown;
  accepts_trade: unknown;
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
        /*
          NULL, NOT EMPTY STRING, for anything the seller left alone. The action
          treats '' and NULL alike and writes neither, but sending null is what
          says so at the boundary rather than relying on that -- and `?? null`
          rather than a truthiness check, so a deliberate empty string is not
          silently turned into something else on the way past.
        */
        $body_style: input.bodyStyle ?? null,
        $transmission: input.transmission ?? null,
        $fuel_type: input.fuelType ?? null,
        $exterior_color: input.exteriorColor ?? null,
        $condition: input.condition ?? null,
        $title_status: input.titleStatus ?? null,
        // `?? null` and not `?? false`: an unanswered question writes no row,
        // and an explicit false writes one saying so.
        $accepts_offers: input.acceptsOffers ?? null,
        $accepts_trade: input.acceptsTrade ?? null,
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

  /**
   * One advertisement, in full. Null when nothing has that id.
   *
   * A PLAIN SELECT RATHER THAN get_listing, and the difference is who can call
   * it. `get_listing` is a view action, view actions are signed, and a signed
   * read means nobody could open a listing without an account -- the same
   * funnel problem `connectReadOnly` exists to avoid, one page further in.
   *
   * It costs nothing to avoid: `get_listing` has no `@caller` in it. It is a
   * pivot over public tables, and Decision 2b leaves SELECT granted, so the
   * pivot can happen here. The projection below is that action's, join for
   * join, including `contact_via` -- which is the custodian's NAME and never
   * the commitment, because publishing the HMAC "would invite clients to treat
   * it as an identifier for the person".
   */
  async get(listingId: bigint | number): Promise<Listing | null> {
    const rows = await this.client.query<DetailRow>(
      `SELECT t.id AS listing_id, t.name AS title, st.name AS state,
              p.display_name AS seller,
              mk.value_text AS make, mo.value_text AS model,
              myv.value_number AS year, pr.value_number AS price,
              cu.value_text AS currency, lo.value_text AS location,
              mi.value_number AS mileage, vi.value_text AS vin,
              de.value_text AS description, ph.value_json AS photos,
              cg.name AS contact_via, t.created_at AS listed_at,
              bs.value_text AS body_style, tr.value_text AS transmission,
              ft.value_text AS fuel_type, ec.value_text AS exterior_color,
              cd.value_text AS condition, ts.value_text AS title_status,
              ao.value_boolean AS accepts_offers,
              at.value_boolean AS accepts_trade
         FROM tokens t
         JOIN token_class_states st ON st.id = t.current_state_id
         JOIN people p              ON p.id = t.issuer_person_id
         LEFT JOIN metadata mk ON mk.entity_type = 'token' AND mk.entity_id = t.id
                              AND mk.identifier = 'make' AND mk.deleted_at IS NULL
         LEFT JOIN metadata mo ON mo.entity_type = 'token' AND mo.entity_id = t.id
                              AND mo.identifier = 'model' AND mo.deleted_at IS NULL
         LEFT JOIN metadata myv ON myv.entity_type = 'token' AND myv.entity_id = t.id
                               AND myv.identifier = 'year' AND myv.deleted_at IS NULL
         LEFT JOIN metadata pr ON pr.entity_type = 'token' AND pr.entity_id = t.id
                              AND pr.identifier = 'price' AND pr.deleted_at IS NULL
         LEFT JOIN metadata cu ON cu.entity_type = 'token' AND cu.entity_id = t.id
                              AND cu.identifier = 'price_currency' AND cu.deleted_at IS NULL
         LEFT JOIN metadata lo ON lo.entity_type = 'token' AND lo.entity_id = t.id
                              AND lo.identifier = 'location' AND lo.deleted_at IS NULL
         LEFT JOIN metadata mi ON mi.entity_type = 'token' AND mi.entity_id = t.id
                              AND mi.identifier = 'mileage' AND mi.deleted_at IS NULL
         LEFT JOIN metadata vi ON vi.entity_type = 'token' AND vi.entity_id = t.id
                              AND vi.identifier = 'vin' AND vi.deleted_at IS NULL
         LEFT JOIN metadata de ON de.entity_type = 'token' AND de.entity_id = t.id
                              AND de.identifier = 'description' AND de.deleted_at IS NULL
         LEFT JOIN metadata ph ON ph.entity_type = 'token' AND ph.entity_id = t.id
                              AND ph.identifier = 'photos' AND ph.deleted_at IS NULL
         LEFT JOIN metadata ct ON ct.entity_type = 'token' AND ct.entity_id = t.id
                              AND ct.identifier = 'contact' AND ct.deleted_at IS NULL
         LEFT JOIN groups cg   ON cg.id = ct.custodian_group_id
         LEFT JOIN metadata bs ON bs.entity_type = 'token' AND bs.entity_id = t.id
                              AND bs.identifier = 'body_style' AND bs.deleted_at IS NULL
         LEFT JOIN metadata tr ON tr.entity_type = 'token' AND tr.entity_id = t.id
                              AND tr.identifier = 'transmission' AND tr.deleted_at IS NULL
         LEFT JOIN metadata ft ON ft.entity_type = 'token' AND ft.entity_id = t.id
                              AND ft.identifier = 'fuel_type' AND ft.deleted_at IS NULL
         LEFT JOIN metadata ec ON ec.entity_type = 'token' AND ec.entity_id = t.id
                              AND ec.identifier = 'exterior_color' AND ec.deleted_at IS NULL
         LEFT JOIN metadata cd ON cd.entity_type = 'token' AND cd.entity_id = t.id
                              AND cd.identifier = 'condition' AND cd.deleted_at IS NULL
         LEFT JOIN metadata ts ON ts.entity_type = 'token' AND ts.entity_id = t.id
                              AND ts.identifier = 'title_status' AND ts.deleted_at IS NULL
         LEFT JOIN metadata ao ON ao.entity_type = 'token' AND ao.entity_id = t.id
                              AND ao.identifier = 'accepts_offers' AND ao.deleted_at IS NULL
         LEFT JOIN metadata at ON at.entity_type = 'token' AND at.entity_id = t.id
                              AND at.identifier = 'accepts_trade' AND at.deleted_at IS NULL
        WHERE t.id = $token_id AND t.deleted_at IS NULL`,
      { $token_id: asQueryInt(BigInt(listingId)) }
    );
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
      bodyStyle: asOptionalText(row.body_style),
      transmission: asOptionalText(row.transmission),
      fuelType: asOptionalText(row.fuel_type),
      exteriorColor: asOptionalText(row.exterior_color),
      condition: asOptionalText(row.condition),
      titleStatus: asOptionalText(row.title_status),
      acceptsOffers: asOptionalBoolean(row.accepts_offers),
      acceptsTrade: asOptionalBoolean(row.accepts_trade),
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
              mlv.value_text  AS location,
              mao.value_boolean AS accepts_offers,
              mat.value_boolean AS accepts_trade,
              mph.value_json AS photos
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
         LEFT JOIN metadata mao ON mao.entity_type = 'token' AND mao.entity_id = t.id
                               AND mao.identifier = 'accepts_offers' AND mao.deleted_at IS NULL
         LEFT JOIN metadata mat ON mat.entity_type = 'token' AND mat.entity_id = t.id
                               AND mat.identifier = 'accepts_trade' AND mat.deleted_at IS NULL
         LEFT JOIN metadata mph ON mph.entity_type = 'token' AND mph.entity_id = t.id
                               AND mph.identifier = 'photos' AND mph.deleted_at IS NULL
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
      acceptsOffers: asOptionalBoolean(row.accepts_offers),
      acceptsTrade: asOptionalBoolean(row.accepts_trade),
      photos: parsePhotos(row.photos),
    };
  }

  /**
   * The durations this chain sells, cheapest first.
   *
   * A plain SELECT, so a seller can be shown what listing costs before they
   * have signed anything. `listing_fee` itself is a `PRIVATE VIEW` and cannot
   * be called from outside the action layer -- but it reads these same rows,
   * so this reproduces its answer rather than guessing at one.
   *
   * Identifiers are parsed here rather than matched with LIKE. `_` is a
   * single-character wildcard, so the obvious `LIKE 'fee_%d'` also matches
   * `feeXd` and anything else of that shape; the pattern below says exactly
   * what a tier identifier is, and a row that does not match is skipped rather
   * than guessed at.
   */
  async fees(): Promise<FeeTier[]> {
    const { $class_id } = await this.classAndState();
    const rows = await this.client.query<{ identifier: unknown; value_number: unknown }>(
      `SELECT identifier, value_number
         FROM metadata
        WHERE entity_type = 'token_class'
          AND entity_id = $class_id
          AND deleted_at IS NULL`,
      { $class_id }
    );

    const tiers: FeeTier[] = [];
    for (const row of rows) {
      const identifier = typeof row.identifier === 'string' ? row.identifier : '';
      const match = /^fee_(\d+)d$/.exec(identifier);
      if (!match) continue;
      tiers.push({
        durationDays: Number(match[1]),
        fee: roundToWholeCredits(toAmount(row.value_number, LISTING_SCALE, identifier), identifier),
      });
    }

    tiers.sort((a, b) => a.durationDays - b.durationDays);
    return tiers;
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

/**
 * A LEFT JOIN that found nothing, kept as null rather than raised.
 *
 * Unlike `asText`, an absent value here is ordinary: these fields are optional
 * and six of them were declared for months before any action could write them,
 * so every listing published before that has null for all of them, for good.
 * Throwing would make the common case an error.
 *
 * An empty string is folded to null too. The chain never writes one -- the
 * action skips a field that is empty -- so if one arrives it came from
 * somewhere that bypassed the action, and "" is not an answer a seller gave.
 */
function asOptionalText(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return value;
}

/**
 * Three states, and the third is the point.
 *
 * `true` and `false` are both answers a seller gave. Anything else -- a null
 * from a LEFT JOIN that matched nothing -- means they were never asked, and
 * must not read as "no".
 */
function asOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
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

/**
 * A `NUMERIC(38,10)` rate as the `NUMERIC(78,0)` charge it becomes.
 *
 * `listing_fee` casts the stored rate to scale 0, and a Postgres numeric cast
 * to a smaller scale ROUNDS -- half away from zero -- rather than truncating.
 * So a rate of 1.6 is charged as 2 credits, and a client that floored it would
 * quote 1, take the seller's agreement to 1, and hand them a 2-credit debit.
 *
 * Every rate configured today is a whole number and this changes nothing for
 * them. It exists for the first fractional one, which will be set by an admin
 * transaction with no client release attached to it.
 */
function roundToWholeCredits(rate: CreditAmount, field: string): CreditAmount {
  if (rate.decimals === 0) return rate;
  const scale = 10n ** BigInt(rate.decimals);
  const negative = rate.units < 0n;
  const magnitude = negative ? -rate.units : rate.units;
  const whole = magnitude / scale;
  const remainder = magnitude % scale;
  // Half away from zero, matching Postgres rather than JavaScript's Math.round,
  // which breaks ties towards positive infinity and would disagree below zero.
  const rounded = remainder * 2n >= scale ? whole + 1n : whole;
  if (rounded < 0n) {
    throw new BranchError(`${field} is negative, which is not a price`);
  }
  return { units: negative ? -rounded : rounded, decimals: 0 };
}
