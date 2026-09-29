import { toAmount, toUnits } from './amount.js';
import { boolArray, intArray, numeric, numericArray, textArray } from './client.js';
import { BranchError } from './errors.js';
import { objectUrl } from './custodians.js';

import type { CreditAmount } from './amount.js';
import type { BranchClient } from './client.js';

/** `value_number` is NUMERIC(38,10); prices and mileage carry that scale. */
export const LISTING_SCALE = 10;

/**
 * The automobile directory, by the slug its type carries on chain.
 *
 * A NAME RATHER THAN A CONSTANT IN A QUERY, because #74 makes the type a thing
 * created by transaction: a second directory is a second slug and nothing else.
 * This package still speaks about exactly one of them -- its projections name
 * `make`, `model` and `vin` -- so the slug is fixed here rather than taken as
 * an argument, and a generic directory client is a separate piece of work.
 */
export const LISTING_TYPE_SLUG = 'automobile-listing';

/**
 * The state a new advertisement starts in, and the one a takedown moves it to.
 *
 * NAMED RATHER THAN INFERRED, now that the chain will no longer infer them.
 * `mint_token` would resolve the lowest-ordinal non-terminal state if handed a
 * null, and `moderate_token` requires a terminal state by name -- both are the
 * generic actions refusing to guess at a type's vocabulary. These two names are
 * what migration 90 gave the automobile type and what the retired actions
 * used; every read path in this file already assumes 'active'.
 */
const ACTIVE_STATE = 'active';
const MODERATED_STATE = 'withdrawn';

/** How a listing ended. Both are terminal states on the automobile type. */
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
  /**
   * When the paid term ends, or null for a listing published without one.
   *
   * Stored and enforced long before it was returned: search drops an expired
   * listing in its WHERE, but nothing selected the column, so no UI could show
   * a seller the duration they had paid for.
   */
  expiresAt: Date | null;
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
  /** When the paid term ends, or null for a listing published without one. */
  expiresAt: Date | null;
}

/**
 * A page key that survives listings sharing a timestamp.
 *
 * `created_at` is `@block_timestamp`, so everything minted in one block has the
 * same value. Paging on it alone repeats or skips rows; the id is the
 * tiebreaker that makes it deterministic, and the browse index
 * `(token_type_id, current_state_id, created_at, id)` is ordered to serve
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
  /*
    THE TEXT FACETS. All eight are matched case-insensitively and folded to
    lower on the way in, because the chain folds on write -- `metadata_schemas
    .folded` is set for all eight (migration 91) and `mint_token` honours it --
    and the filter has to compare against what was stored.

    They cost ONE join between them, however many are supplied — a single pass
    over `metadata` keeping the listings that matched every requested
    (identifier, value) pair. Adding a ninth is free.

    A listing that said nothing about a facet is excluded by a filter on it,
    which is the point of writing no row for an unanswered field: absent is
    genuinely absent rather than an empty string masquerading as an answer.
  */
  make?: string;
  model?: string;
  bodyStyle?: string;
  transmission?: string;
  fuelType?: string;
  exteriorColor?: string;
  condition?: string;
  titleStatus?: string;

  /**
   * Only `true` narrows; `false` and `undefined` do not filter at all.
   *
   * "Cars whose seller declined offers" is not a search anybody performs, and
   * offering it would quietly exclude every listing published before the field
   * existed — those are null, not false.
   */
  acceptsOffers?: boolean;
  acceptsTrade?: boolean;

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
 * automobile token type -- `fee_30d`, `fee_180d` -- precisely so the admin
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
  /** Days the listing stays active. `mint_token` takes this as `$duration_days`. */
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

/**
 * One row of `token_fields`: a record, a declared field, and that field's value
 * in whichever column its datatype uses.
 *
 * `value_hmac` is hex rather than bytes -- the column is BYTEA and a TEXT return
 * refuses it, and hex is the form the custodian publishes a commitment in, so a
 * client recomputing one compares like with like.
 */
interface FieldRow {
  token_id: unknown;
  identifier: unknown;
  datatype: unknown;
  value_text: unknown;
  value_number: unknown;
  value_boolean: unknown;
  value_datetime: unknown;
  value_json: unknown;
  value_hmac: unknown;
  custodian_url: unknown;
}

/** One row of `search_tokens`: identity only. The fields come separately. */
interface SearchHit {
  token_id: unknown;
  name: unknown;
  state: unknown;
  created_at: unknown;
  type_id: unknown;
  type_version: unknown;
}

/** One row of `my_tokens`, which adds the terminal flag a seller's page needs. */
interface OwnHit {
  token_id: unknown;
  name: unknown;
  state: unknown;
  is_terminal: unknown;
  created_at: unknown;
  type_id: unknown;
  type_version: unknown;
}

/** One row of `get_token`: the record's identity repeated, plus one field. */
interface DetailHit {
  token_id: unknown;
  type_slug: unknown;
  name: unknown;
  state: unknown;
  issuer_person: unknown;
  created_at: unknown;
  identifier: unknown;
  datatype: unknown;
  is_brokered: unknown;
  custodian_name: unknown;
  value_text: unknown;
  value_number: unknown;
  value_boolean: unknown;
  value_datetime: unknown;
  value_json: unknown;
}

/*
  THE PIVOTS.

  These exist so the mapping below them did not have to change: `toSummary` and
  `get`'s object literal still read a flat row with a property per field, and only
  the way that row is OBTAINED moved from a SELECT with fourteen joins to an action
  plus a lookup. Keeping the mappers meant the change is in one layer rather than
  two, and every unit test over them still means what it meant.

  They are also the seam where a generic SDK would cut: everything above is
  type-agnostic, and the car vocabulary starts exactly here. See
  badger-cash/branch-sdk-js#46.
*/
function summaryRowFrom(
  hit: SearchHit,
  fields: Map<string, FieldRow>,
  photoBase: string | null
): SummaryRow {
  const t = (k: string): unknown => fields.get(k)?.value_text ?? null;
  const n = (k: string): unknown => fields.get(k)?.value_number ?? null;
  const b = (k: string): unknown => fields.get(k)?.value_boolean ?? null;
  return {
    id: hit.token_id,
    name: hit.name,
    created_at: hit.created_at,
    make: t('make'),
    model: t('model'),
    year: n('year'),
    price: n('price'),
    currency: t('price_currency'),
    location: t('location'),
    accepts_offers: b('accepts_offers'),
    accepts_trade: b('accepts_trade'),
    photos: fields.get('photos')?.value_json ?? null,
    // THE FIELD'S OWN URL, not a network-wide one. #118 made the declaration the
    // type's, so the endpoint travels with the field in `token_fields`; the
    // cached fallback covers `get_token`, which does not carry it.
    photo_base: fields.get('photos')?.custodian_url ?? photoBase,
  };
}

function detailRowFrom(
  head: DetailHit,
  fields: Map<string, DetailHit>,
  photoBase: string | null
): DetailRow {
  const t = (k: string): unknown => fields.get(k)?.value_text ?? null;
  const n = (k: string): unknown => fields.get(k)?.value_number ?? null;
  const b = (k: string): unknown => fields.get(k)?.value_boolean ?? null;
  return {
    listing_id: head.token_id,
    title: head.name,
    state: head.state,
    seller: head.issuer_person,
    listed_at: head.created_at,
    make: t('make'),
    model: t('model'),
    year: n('year'),
    price: n('price'),
    currency: t('price_currency'),
    location: t('location'),
    mileage: n('mileage'),
    vin: t('vin'),
    description: t('description'),
    body_style: t('body_style'),
    transmission: t('transmission'),
    fuel_type: t('fuel_type'),
    exterior_color: t('exterior_color'),
    condition: t('condition'),
    title_status: t('title_status'),
    accepts_offers: b('accepts_offers'),
    accepts_trade: b('accepts_trade'),
    photos: fields.get('photos')?.value_json ?? null,
    expires_at: fields.get('expires_at')?.value_datetime ?? null,
    /*
      A BROKERED FIELD ARRIVES AS A COMMITMENT AND NEVER AS A VALUE, so what a
      detail page can honestly say is WHO HOLDS the contact details -- not what
      they are. `get_token` returns the custodian's name for exactly this, which
      is why the field is called contact_via rather than contact.
    */
    contact_via: fields.get('contact')?.custodian_name ?? null,
    photo_base: photoBase,
  };
}

interface SummaryRow {
  photo_base: unknown;
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
  expires_at: unknown;
  photo_base: unknown;
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

/**
 * One of `mint_token`'s six key/value pairs, built so the two stay the same
 * length.
 *
 * THE PAIRING IS THE HAZARD, and it is silent. `unnest(keys, values)` zips to
 * the LONGER array and pads the shorter with NULLs, so a mismatch does not
 * fail: it writes a real value against a null identifier, or a null against a
 * real one, and lands as a constraint violation much later naming a column
 * rather than the mistake. The action checks all six lengths for exactly that
 * reason, and this makes the check unreachable by construction rather than
 * relying on two array literals being edited together.
 *
 * An absent value appends nothing to EITHER array, which is how a field the
 * seller said nothing about writes no row at all.
 */
class FieldPairs {
  readonly keys: string[] = [];
  readonly values: string[] = [];

  put(identifier: string, value: string | null | undefined): void {
    if (value === null || value === undefined || value === '') return;
    this.keys.push(identifier);
    this.values.push(value);
  }
}

/** The same, for the boolean pair, where `false` is an answer and must land. */
class BoolPairs {
  readonly keys: string[] = [];
  readonly values: boolean[] = [];

  put(identifier: string, value: boolean | undefined): void {
    if (value === undefined) return;
    this.keys.push(identifier);
    this.values.push(value);
  }
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
   * `mint_token`, NOT `create_listing`. badger-cash/branch#74 retired the seven
   * automobile-shaped actions: a directory is now a token type created by
   * transaction, and the generic mint writes whatever that type's
   * `metadata_schemas` declare. Nothing in the binary knows what a car is any
   * more, so every named parameter became a declared field arriving in one of
   * six typed key/value array pairs.
   *
   * WHAT THE SDK HAD TO TAKE OVER, because the action no longer does it:
   *
   *   * `tokens.name`. `create_listing` composed `year || ' ' || make || ' ' ||
   *     model` in straight-line code. `mint_token` is handed the name, because
   *     it cannot know that this type's display line is built from three of its
   *     fields. Composed here rather than in the front end -- one caller
   *     spelling it differently is a directory with two title conventions in it.
   *   * The type. `create_listing` resolved the automobile type itself;
   *     `mint_token` takes one. `typeAndState` resolves it by `live_slug`.
   *
   * WHAT THE CHAIN STILL OWNS, and must not be duplicated here:
   *
   *   * Folding. DO NOT FOLD HERE, and the temptation is real, because the
   *     rule moved rather than disappeared. `create_listing` called `lower()`
   *     by hand; `mint_token` reads `metadata_schemas.folded` and writes
   *     `CASE WHEN d.folded THEN lower(t.v) ELSE t.v END`
   *     (41-explicit-mint-policy.sql:1245), and migration 91 set that column on
   *     `make`, `model`, `price_currency`, `vin` and the six descriptors --
   *     exactly the fields `create_listing` folded, and only those, so
   *     `location` and `description` keep their capitals as they always did.
   *     Folding a tenth field here would store a value the declaration does not
   *     describe, which is the same defect badger-cash/branch#2 was, arriving
   *     from the client instead. Values go out as the seller typed them.
   *   * `tokens.name`, therefore, is composed from the UNFOLDED input, below.
   *     It is the display line and must keep the seller's own capitalisation --
   *     which is also what the publish form previews before submitting.
   *   * `expires_at`, computed from `$duration_days` -- and REFUSED if supplied,
   *     so two clients cannot disagree about what thirty days means.
   *   * The VIN rule, now `unique_scope = 'type_active'` on the declaration
   *     (migration 93) rather than a hand-written query in the action.
   *   * The fee and its settlement. The type's `mint_policy` is `fee`, so a term
   *     is mandatory and there is no free path (migration 41).
   *
   * A FIELD IS OMITTED RATHER THAN SENT EMPTY. Under `create_listing` an empty
   * string and a null both wrote no row; here a key that is present writes one,
   * so `''` would record an empty answer where the seller gave none. A required
   * field left empty is refused by the chain by name, which is a better error
   * than any this could raise.
   */
  async create(input: CreateListingInput): Promise<string> {
    // The live version, resolved through an action. `create` mints into whichever
    // version is current, which is the whole point of the family sentinel.
    const $type_id = await this.liveTypeId();

    const text = new FieldPairs();
    text.put('make', input.make);
    text.put('model', input.model);
    text.put('price_currency', input.priceCurrency);
    text.put('location', input.location);
    text.put('vin', input.vin);
    text.put('description', input.description);
    text.put('body_style', input.bodyStyle);
    text.put('transmission', input.transmission);
    text.put('fuel_type', input.fuelType);
    text.put('exterior_color', input.exteriorColor);
    text.put('condition', input.condition);
    text.put('title_status', input.titleStatus);

    const numbers = new FieldPairs();
    numbers.put('price', decimalString(input.price, 'price'));
    numbers.put('year', decimalString(input.year, 'year'));
    numbers.put('mileage', decimalString(input.mileage, 'mileage'));

    // An unanswered question writes no row and an explicit `false` writes one
    // saying so, which here is the difference between sending the key and not
    // sending it. Collapsing the two would tell a buyer somebody refused them
    // when nobody was asked.
    const booleans = new BoolPairs();
    booleans.put('accepts_offers', input.acceptsOffers);
    booleans.put('accepts_trade', input.acceptsTrade);

    return await this.client.write(
      'mint_token',
      {
        $type_id,
        $state_name: ACTIVE_STATE,
        $name: `${String(input.year)} ${input.make} ${input.model}`,
        // The seller holds their own advertisement: the mint resolves their
        // holder from @caller when this is null.
        $to_holder_id: null,
        // No agency signs an ad into existence. The type's `issuer_kind` is
        // 'person', and a group here would be refused.
        $as_group_id: null,
        // The mint opens the settlement the fee is paid inside, which is
        // invariant 15 -- the payment and the thing it paid for share one
        // envelope. Handing it an existing one is for a caller batching several
        // mints, which this is not.
        $settlement_id: null,
        $duration_days: input.durationDays,
        // BOTH NULL FOR A NON-FUNGIBLE, and the action refuses either being
        // set. An advertisement is one thing, not a quantity of them.
        $symbol: null,
        $quantity: null,
        $note: 'listing published',
        $text_keys: text.keys,
        $text_values: text.values,
        $number_keys: numbers.keys,
        $number_values: numbers.values,
        $boolean_keys: booleans.keys,
        $boolean_values: booleans.values,
        // EMPTY, AND IT HAS TO BE. `expires_at` is the only datetime this type
        // declares, and supplying it alongside a paid term is refused.
        $datetime_keys: [],
        $datetime_values: [],
        // `photos` is declared `json` and holds the object keys as one array,
        // because an identifier cannot repeat on one entity.
        $json_keys: ['photos'],
        $json_values: [JSON.stringify(input.photos ?? [])],
        // THE COMMITMENT, NEVER THE VALUE. `contact` is declared
        // `requires_custodian`, so the chain stores an HMAC and a custodian's
        // name. Every validator holds every row permanently and reads are
        // unauthenticated, so the details stay off-chain by construction.
        $brokered_keys: ['contact'],
        $brokered_hmacs: [input.contactHmacHex],
      },
      {
        // Nothing infers to NUMERIC, and an empty array infers to `null[]`.
        // client.ts's note on `textArray` says why all twelve are declared
        // rather than only the ones that obviously cannot infer.
        $quantity: numeric(78, 0),
        $text_keys: textArray,
        $text_values: textArray,
        $number_keys: textArray,
        $number_values: numericArray(38, 10),
        $boolean_keys: textArray,
        $boolean_values: boolArray,
        $datetime_keys: textArray,
        $datetime_values: intArray,
        $json_keys: textArray,
        $json_values: textArray,
        $brokered_keys: textArray,
        $brokered_hmacs: textArray,
      }
    );
  }

  /**
   * End a listing. `sold` and `withdrawn` are the only outcomes.
   *
   * `close_token`, which reads the target state out of the TYPE'S OWN
   * vocabulary rather than from a hardcoded pair. `close_listing` validated
   * `'sold' | 'withdrawn'` itself; the generic action instead requires the named
   * state to exist on this type and to be terminal -- which is the same two
   * values here, because those are the terminal states migration 90 gave the
   * automobile type, and is what stops this becoming a "move my record
   * anywhere" verb on a type with more of them.
   *
   * Authority is unchanged and is ownership, not an office: the person whose
   * `issuer_person_id` is on the token, and nobody else.
   */
  async close(listingId: bigint | number, outcome: ListingOutcome): Promise<string> {
    return await this.client.write('close_token', {
      $token_id: asActionInt(listingId),
      $state_name: outcome,
    });
  }

  /**
   * Take a listing down, as the listing-moderator office.
   *
   * NOT `close`. A seller ending their own advertisement and a moderator
   * removing somebody else's are different acts with different authority, and
   * the chain records them differently: this writes a `moderated` event
   * carrying the acting role and the reason, so the takedown is attributable
   * afterwards to the office that made it.
   *
   * The reason is mandatory and the action refuses an empty one -- a takedown
   * nobody has to justify is a takedown nobody can review.
   *
   * Authority is the chain's, and is now read from the TYPE rather than from a
   * hardcoded id: `moderate_token` looks up `token_types.burning_role_id`
   * for whatever type the record belongs to and calls `require_office` against
   * it. For the automobile type that is the same `listing-moderator` office
   * `moderate_listing` required, so nothing changes for this caller -- and the
   * refusal still arrives as an ActionFailedError whatever a client believed
   * when it offered the button.
   *
   * THE TAKEDOWN STATE IS 'withdrawn', which is what `moderate_listing` moved a
   * listing to. It is not an argument here, because there is exactly one
   * terminal state on this type that means "taken down" and offering a choice
   * would let a moderator file a takedown as 'sold'. The event's kind is
   * `moderated` and carries the acting role, so the two are distinguishable
   * afterwards despite sharing a state.
   */
  async moderate(listingId: bigint | number, reason: string): Promise<string> {
    return await this.client.write('moderate_token', {
      $token_id: asActionInt(listingId),
      $state_name: MODERATED_STATE,
      $reason: reason,
    });
  }

  /**
   * Set what a listing of a given duration costs.
   *
   * A DIFFERENT OFFICE FROM MODERATION, and the separation is deliberate on the
   * chain: `set_type_fee` requires the governing organization's admin office,
   * while `moderate_token` requires the type's `burning_role_id`. Taking an
   * advertisement down and changing what advertisements cost are not the same
   * authority, so a UI that treats "holds an office" as one thing will offer
   * this to somebody the node refuses.
   *
   * `set_type_fee` TAKES THE TYPE, where `set_listing_fee` resolved the
   * automobile type for itself. Resolved here through `typeAndState`, so the
   * signature is unchanged: a caller repricing this directory should not have
   * to know its id.
   *
   * The fee is NUMERIC(38,10) and is declared: nothing infers to NUMERIC, so a
   * string would infer text and a number int8, and the action refuses both.
   */
  async setFee(durationDays: bigint | number, fee: string | number): Promise<string> {
    const $type_id = await this.liveTypeId();
    return await this.client.write(
      'set_type_fee',
      {
        $type_id,
        $duration_days: asActionInt(durationDays),
        $fee: decimalString(fee, 'fee'),
      },
      { $fee: numeric(38, 10) }
    );
  }

  /**
   * One advertisement, in full. Null when nothing has that id.
   *
   * A PLAIN SELECT, AND NOT FOR THE REASON THIS COMMENT USED TO GIVE.
   *
   * It said `get_listing` was a view action, that view actions are signed, and
   * that routing detail through one would mean nobody could open a listing
   * without an account. THAT IS FALSE, and badger-cash/branch#66 established
   * why: a PUBLIC VIEW action that reads no `@caller` needs no signer at all.
   * kwil-db's `core/types/message.go:83` only requires a signature when the
   * message carries a sender, and `test/e2e/generic-reads.sh` calls all three
   * generic reads unsigned against a running node. The belief cost nothing here
   * because the SELECT works, but it is the kind of thing that gets copied.
   *
   * `get_listing` is gone regardless -- migration 45 retired it with the rest of
   * the automobile read views -- so the standing question is whether this should
   * become `get_token`. DECIDED: NO, NOT YET. `get_token` returns a type's
   * fields generically, which means this method would have to pivot rows into
   * `Listing` here and would lose the two joins that make the projection worth
   * having: `contact_via`, the custodian's NAME rather than the commitment, and
   * `photo_base`, the custodian endpoint that turns an opaque object key into a
   * URL the browser can fetch. Both come back with the row today rather than
   * costing a second round trip. The same holds for `search_tokens`, which
   * migration 46 notes has no numeric range facet, no expiry filter and no card
   * projection -- which is why `browse_listings` was deliberately kept on chain
   * rather than retired with the rest. Moving the read path is its own piece of
   * work, and it belongs with whatever makes the generic reads cover the front
   * page.
   *
   * The DDL these SELECTs read is untouched by #74: 23, 24 and 90 are applied
   * and immutable, and only the action layer was retired. Decision 2b leaves
   * SELECT granted, so the pivot happens here.
   */
  async get(listingId: bigint | number): Promise<Listing | null> {
    /*
      `get_token` IS ALREADY LONG FORMAT: identity columns repeated per field row,
      plus that field's value. So this pivots rather than joining, and the
      fourteen LEFT JOINs this replaced are gone -- along with the assumption that
      every one of them names a column a car happens to have.

      ONE EXTRA CALL FOR THE PHOTO ENDPOINT, cached. `get_token` gives the
      declaration's custodian IDS but not its resolved url, and an object key
      without an address renders nothing and reports nothing.
    */
    const rows = await this.client.readPublic<DetailHit>('get_token', {
      $token_id: asQueryInt(BigInt(listingId)),
    });
    if (rows.length === 0) return null;

    const head = rows[0];
    if (head === undefined) return null;
    const fields = new Map<string, DetailHit>();
    for (const r of rows) {
      const identifier = typeof r.identifier === 'string' ? r.identifier : '';
      if (identifier !== '') fields.set(identifier, r);
    }

    const row: DetailRow = detailRowFrom(head, fields, await this.photoBase());

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
      photos: parsePhotos(row.photos, row.photo_base),
      contactVia: asText(row.contact_via, 'contact_via'),
      listedAt: toDate(row.listed_at),
      expiresAt: toOptionalDate(row.expires_at),
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
  /*
    ─────────────────────────────────────────────────────────────────────────
    THE READ PATH GOES THROUGH ACTIONS, NOT THROUGH TABLES.

    badger-cash/branch#119. Every read here used to be a plain `SELECT`, on the
    strength of decision 2b leaving SELECT granted -- so browse and search needed
    no server-side code and no action per query. That held until the schema moved:
    branch#69 renamed the registry and branch#118 made field declarations
    type-scoped, and each one emptied the grid with an error INSIDE an HTTP 200.
    The page rendered, the filters painted, nothing logged, and there were no cars.

    A table name is not an interface. An action is.
    ─────────────────────────────────────────────────────────────────────────
  */

  /**
   * Every declared field of a set of records, keyed by id and then identifier.
   *
   * One call for a whole page. `token_fields` returns long format -- a row per
   * (record, field) -- so this pivots it once and the callers read it like an
   * object. Two round trips for a grid, never one per card.
   */
  private async fieldsFor(ids: bigint[]): Promise<Map<string, Map<string, FieldRow>>> {
    const byToken = new Map<string, Map<string, FieldRow>>();
    if (ids.length === 0) return byToken;

    const rows = await this.client.readPublic<FieldRow>('token_fields', {
      $token_ids: ids.map((id) => asQueryInt(id)),
    });

    for (const row of rows) {
      const key = String(toUnits(row.token_id, 'token_id'));
      let fields = byToken.get(key);
      if (fields === undefined) {
        fields = new Map<string, FieldRow>();
        byToken.set(key, fields);
      }
      fields.set(asText(row.identifier, 'identifier'), row);
    }
    return byToken;
  }

  /**
   * The live type id for this directory's family.
   *
   * `current_type_version` rather than a SELECT on `live_slug`, which also settles
   * #44: the action resolves the family's CURRENT version, where the old query
   * cached one type id for the client's lifetime and pinned the front end to
   * whichever version was live when the page loaded. Still cached, because a page
   * does not publish a new version underneath itself -- but cached from an action.
   */
  private async liveTypeId(): Promise<number> {
    if (this.cachedTypeId !== undefined) return this.cachedTypeId;
    const rows = await this.client.readPublic<{ type_id: unknown }>('current_type_version', {
      $family: LISTING_TYPE_SLUG,
    });
    const row = rows[0];
    if (!row) {
      throw new BranchError(`the ${LISTING_TYPE_SLUG} type is not configured on this chain`);
    }
    this.cachedTypeId = asQueryInt(toUnits(row.type_id, 'type_id'));
    return this.cachedTypeId;
  }

  private cachedTypeId: number | undefined;

  /**
   * Where the custodian holding this directory's photographs answers.
   *
   * A photograph is an object KEY (#109) and the address is the declaration's to
   * give. Resolved through the action, WITH the type, because #118 made the
   * declaration the type's own -- and a client that has the keys and not the
   * endpoint renders an empty grid with no error at all.
   */
  private async photoBase(): Promise<string | null> {
    if (this.cachedPhotoBase !== undefined) return this.cachedPhotoBase;
    const rows = await this.client.readPublic<{ url: unknown }>(
      'metadata_field_custodian_endpoint',
      { $type_id: await this.liveTypeId(), $entity_type: 'token', $identifier: 'photos' }
    );
    const row = rows[0];
    this.cachedPhotoBase = row === undefined ? null : asText(row.url, 'url');
    return this.cachedPhotoBase;
  }

  private cachedPhotoBase: string | null | undefined;

  async search(options: SearchOptions = {}): Promise<ListingSummary[]> {
    const limit = clampLimit(options.limit);

    /*
      THE FACETS ARE (identifier, value) PAIRS, not named parameters, because
      that is what the action takes. `browse_listings` spelled every filter out
      -- $make, $model, $year_min, $year_max, $price_max -- so a new facet meant
      a new parameter on a generic action. `search_tokens` keys them by
      identifier, so the eight text descriptors, two ranges and two flags below
      are data rather than signature.
    */
    const textKeys: string[] = [];
    const textValues: string[] = [];
    for (const [identifier, value] of [
      ['make', options.make],
      ['model', options.model],
      ['body_style', options.bodyStyle],
      ['transmission', options.transmission],
      ['fuel_type', options.fuelType],
      ['exterior_color', options.exteriorColor],
      ['condition', options.condition],
      ['title_status', options.titleStatus],
    ] as Array<[string, string | undefined]>) {
      // TRIMMED, because '   ' is not a body style a seller chose. The old shape
      // trimmed before building its join and this has to match.
      const trimmed = value === undefined ? '' : value.trim();
      if (trimmed === '') continue;
      textKeys.push(identifier);
      // FOLDED HERE AS WELL AS ON CHAIN. mint_token lowercases a field its
      // declaration marks folded, and the action compares against what was
      // stored, so a buyer typing 'Toyota' has to arrive as 'toyota'.
      textValues.push(trimmed.toLowerCase());
    }

    /*
      RANGES AS THREE PARALLEL ARRAYS, with a NULL bound meaning unbounded on
      that side. year carries both ends; maxPrice only an upper one.
    */
    /*
      VALIDATED HERE, STILL. The bounds used to be INLINED into the SQL, so this
      check was an injection guard -- '2015; DROP TABLE tokens' had to be refused
      before it reached a statement. They are parameters now and injection is not
      the risk; the check stays because the failure it prevents is worse than it
      was. An unvalidated bound reaches the action, fails its `::NUMERIC(38,10)`
      cast, and comes back as a cast error from the planner: a caller who typed a
      price wrong learns it from the database rather than from the parameter.
    */
    const bound = (value: string | number, field: string): string => {
      const text = String(value).trim();
      if (!/^-?\d+(\.\d+)?$/.test(text)) {
        throw new BranchError(`${field} must be a decimal number, not ${JSON.stringify(value)}`);
      }
      return text;
    };

    const numberKeys: string[] = [];
    const numberMins: Array<string | null> = [];
    const numberMaxs: Array<string | null> = [];
    if (options.yearFrom !== undefined || options.yearTo !== undefined) {
      numberKeys.push('year');
      numberMins.push(options.yearFrom === undefined ? null : bound(options.yearFrom, 'yearFrom'));
      numberMaxs.push(options.yearTo === undefined ? null : bound(options.yearTo, 'yearTo'));
    }
    if (options.maxPrice !== undefined) {
      numberKeys.push('price');
      numberMins.push(null);
      numberMaxs.push(bound(options.maxPrice, 'maxPrice'));
    }

    const booleanKeys: string[] = [];
    const booleanValues: boolean[] = [];
    if (options.acceptsOffers === true) {
      booleanKeys.push('accepts_offers');
      booleanValues.push(true);
    }
    if (options.acceptsTrade === true) {
      booleanKeys.push('accepts_trade');
      booleanValues.push(true);
    }

    /*
      THE BOUNDS TRAVEL AS DECIMAL STRINGS, and the action casts them.

      They used to be NUMERIC(38,10)[] and that could not be called reliably from
      here, which only a running node revealed. Nothing infers to NUMERIC, so an
      undeclared [2021] arrives as int8[] and is refused; declaring the type fixes
      that, and then an array whose elements are ALL NULL arrives as numeric(0,0)[]
      and is refused anyway -- which is precisely the array a caller filtering
      `year >= 2015` with no upper bound produces. The common case was the broken
      one, and it passed a unit test with a fake provider.

      Text has none of it: text infers as text, a NULL element stays NULL, and the
      precision is stated in the action rather than guessed from a value.
    */
    const found = await this.client.readPublic<SearchHit>('search_tokens', {
      $type_slug: LISTING_TYPE_SLUG,
      $text_keys: textKeys.length > 0 ? textKeys : null,
      $text_values: textValues.length > 0 ? textValues : null,
      $limit: limit,
      $after_created_at: options.after
        ? asQueryInt(BigInt(Math.floor(options.after.listedAt.getTime() / 1000)))
        : null,
      $after_id: options.after ? asQueryInt(options.after.listingId) : null,
      $type_version: null,
      $number_keys: numberKeys.length > 0 ? numberKeys : null,
      $number_mins: numberMins.length > 0 ? numberMins : null,
      $number_maxs: numberMaxs.length > 0 ? numberMaxs : null,
      $boolean_keys: booleanKeys.length > 0 ? booleanKeys : null,
      $boolean_values: booleanValues.length > 0 ? booleanValues : null,
    });

    const ids = found.map((hit) => toUnits(hit.token_id, 'token_id'));
    const fields = await this.fieldsFor(ids);
    const base = await this.photoBase();

    /*
      EXPIRED RECORDS ARE FILTERED HERE, and that is a real difference from the
      retired action. `browse_listings` compared expires_at against
      @block_timestamp on chain; `search_tokens` excludes terminal STATES but
      knows nothing about deadlines, because a deadline is one directory's
      declared field and not a property of a token. A lapsed record is still
      `active` until the permissionless sweep moves it, so a grid that showed it
      would be advertising something whose term has run out.
    */
    const now = Math.floor(Date.now() / 1000);
    const out: ListingSummary[] = [];
    for (const hit of found) {
      const id = toUnits(hit.token_id, 'token_id');
      const f = fields.get(String(id)) ?? new Map<string, FieldRow>();
      const expires = f.get('expires_at')?.value_datetime;
      if (expires !== undefined && expires !== null && Number(expires) <= now) continue;
      out.push(this.toSummary(summaryRowFrom(hit, f, base)));
    }
    return out;
  }

  /**
   * The caller's own listings, in every state.
   *
   * Not filtered to active: a seller needs to see what they withdrew, sold, or
   * let expire. Resolved through `person_keys` on the canonical address, which
   * is the lookup that fails open if it is not normalised.
   */
  async mine(options: { limit?: number } = {}): Promise<OwnListing[]> {
    /*
      `my_tokens` RESOLVES THE CALLER, which this used to do by hand: it joined
      `person_keys` on `this.client.address` and carried the confirmed/revoked
      predicates itself. That made the client the owner of the
      address-normalisation rule -- `WHERE address = lower(@caller)` -- which is
      the single most repeated trap in this schema and not a client's to keep.
    */
    const found = await this.client.read<OwnHit>('my_tokens', {
      $type_slug: LISTING_TYPE_SLUG,
      $limit: clampLimit(options.limit),
    });

    // The seller paid for the term, so this is the page that most needs it.
    const fields = await this.fieldsFor(found.map((h) => toUnits(h.token_id, 'token_id')));

    return found.map((hit) => {
      const f = fields.get(String(toUnits(hit.token_id, 'token_id')));
      return {
        listingId: toUnits(hit.token_id, 'token_id'),
        title: asText(hit.name, 'name'),
        state: asText(hit.state, 'state'),
        listedAt: toDate(hit.created_at),
        expiresAt: toOptionalDate(f?.get('expires_at')?.value_datetime ?? null),
      };
    });
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
      photos: parsePhotos(row.photos, row.photo_base),
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
    /*
      `type_fee_tiers` RETURNS THE RATE CARD AS A SET. `listing_fee` answers for
      ONE term, so a client offering a seller their choices had to read `metadata`
      and filter for `fee_%d` itself -- which is how this package ended up owning
      the identifier grammar. The action returns the identifier and the price; the
      grammar stays here because a regex is the right tool for it, but the rows
      come from an action rather than a table.

      A tier whose identifier does not parse is skipped rather than guessed at.
    */
    const rows = await this.client.readPublic<{ identifier: unknown; fee: unknown }>(
      'type_fee_tiers',
      { $type_slug: LISTING_TYPE_SLUG }
    );

    const tiers: FeeTier[] = [];
    for (const row of rows) {
      const identifier = typeof row.identifier === 'string' ? row.identifier : '';
      const match = /^fee_(\d+)d$/.exec(identifier);
      if (!match) continue;
      tiers.push({
        durationDays: Number(match[1]),
        // Rounded to whole credits, as the chain charges them. Dropped by accident
        // in the move to the action, and the fees tests caught it.
        fee: roundToWholeCredits(toAmount(row.fee, LISTING_SCALE, identifier), identifier),
      });
    }
    tiers.sort((a, b) => a.durationDays - b.durationDays);
    return tiers;
  }
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

/**
 * An expiry, or null when the listing has none.
 *
 * Null is a real answer rather than a missing one: `expires_at` is optional
 * metadata, so a listing published without a duration never lapses. Coercing
 * that to a date would invent an expiry the chain does not hold, and the UI
 * would then tell a seller their listing had ended.
 */
function toOptionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

/** `photos` is one metadata row holding a JSON array, because an identifier
 * cannot repeat on one entity. */
function parsePhotoKeys(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Photographs as a browser can fetch them, composed from the custodian address
 * that came back with the row.
 *
 * WHAT IS ON CHAIN IS AN OPAQUE KEY. The base arrives from the same query
 * rather than a second one, so a caller never holds a key it cannot render and
 * a grid never paints placeholders and then swaps in pictures.
 *
 * A key that cannot be resolved is DROPPED. If no custodian has announced there
 * is no address to build, and a relative path would render as a broken image
 * against whatever origin the page happens to be on. An absolute URL passes
 * through untouched, because listings published before keys replaced URLs carry
 * one and still have to render.
 */
function parsePhotos(value: unknown, base: unknown): string[] {
  const keys = parsePhotoKeys(value);
  const host = typeof base === 'string' && base !== '' ? base : null;
  return keys
    .map((key) =>
      key.startsWith('http://') || key.startsWith('https://')
        ? key
        : host
          ? objectUrl(host, key)
          : null
    )
    .filter((url): url is string => url !== null);
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
