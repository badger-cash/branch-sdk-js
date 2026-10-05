import { METADATA_NUMERIC_SCALE, toAmount, toUnits } from './amount.js';
// ONE IMPLEMENTATION, NOT TWO. These were private here until tokens.ts needed
// the same three; a second copy of the MAX_SAFE_INTEGER check is a second
// place to forget it.
import { asQueryInt, asText } from './coerce.js';
import { objectUrl } from './custodians.js';

import type { CreditAmount } from './amount.js';
import type { FeeTier } from './tokenTypes.js';
import type {
  BooleanFacet,
  RangeFacet,
  TextFacet,
  TokenField,
  TokenHit,
  TokenRecord,
} from './tokens.js';
import type { BranchClient } from './client.js';

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
// `FeeTier` lives on the types client now (#55). The reasoning above is kept
// here because it is about this directory's rate card rather than the shape.

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
function summaryRowFrom(hit: TokenHit, fields: Map<string, TokenField>): SummaryRow {
  const t = (k: string): unknown => fields.get(k)?.text ?? null;
  const n = (k: string): unknown => fields.get(k)?.number ?? null;
  const b = (k: string): unknown => fields.get(k)?.boolean ?? null;
  return {
    id: hit.tokenId,
    name: hit.name,
    created_at: Math.floor(hit.createdAt.getTime() / 1000),
    make: t('make'),
    model: t('model'),
    year: n('year'),
    price: n('price'),
    currency: t('price_currency'),
    location: t('location'),
    accepts_offers: b('accepts_offers'),
    accepts_trade: b('accepts_trade'),
    photos: fields.get('photos')?.json ?? null,
    // THE FIELD'S OWN URL, and there is no fallback any more. #118 made the
    // declaration the type's so the endpoint travels with the field, and #122
    // taught `get_token` to resolve it too — so the cached network-wide base the
    // fallback used to supply has no remaining caller.
    photo_base: fields.get('photos')?.custodianUrl ?? null,
  };
}

function detailRowFrom(record: TokenRecord): DetailRow {
  const fields = record.fields;
  const t = (k: string): unknown => fields.get(k)?.text ?? null;
  const n = (k: string): unknown => fields.get(k)?.number ?? null;
  const b = (k: string): unknown => fields.get(k)?.boolean ?? null;
  return {
    listing_id: record.tokenId,
    title: record.name,
    state: record.state,
    seller: record.issuerPerson,
    listed_at: Math.floor(record.createdAt.getTime() / 1000),
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
    photos: fields.get('photos')?.json ?? null,
    expires_at: fields.get('expires_at')?.datetime ?? null,
    /*
      A BROKERED FIELD ARRIVES AS A COMMITMENT AND NEVER AS A VALUE, so what a
      detail page can honestly say is WHO HOLDS the contact details -- not what
      they are. `get_token` returns the custodian's name for exactly this, which
      is why the field is called contact_via rather than contact.
    */
    contact_via: fields.get('contact')?.custodianName ?? null,
    /*
      THE ROW'S OWN URL, AND NO EXTRA CALL FOR IT.
      badger-cash/branch#122 taught `get_token` to resolve `custodian_url` from the
      DECLARATION that governs each field, so the separate
      `metadata_field_custodian_endpoint` lookup this used to await — which itself
      awaited a `current_type_version` call first — is gone. A detail page cost
      three round trips and now costs one, which is the same saving #49 made for
      the grid and which was only half collected at the time.
    */
    photo_base: fields.get('photos')?.custodianUrl ?? null,
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
 * Publishing, closing, and every read path a buyer uses.
 *
 * Writes go through actions, which is where the fee, the VIN guard and the
 * expiry stamp live. Reads are plain SELECTs: decision 2b leaves `SELECT`
 * granted, so the entire browse and search surface needs no server-side code.
 */
/**
 * The automobile directory, as a thin adapter over the generic token surface.
 *
 * @deprecated Since 0.6.0; removed in **0.7.0**. Use `client.tokens` and
 * `client.types` with the directory's own slug, and keep the car vocabulary in
 * the application. Tracked by badger-cash/island-nook-directory-45#197.
 *
 * WHY AN ADAPTER RATHER THAN A CLEAN BREAK. `island-nook-directory-45` consumes
 * this surface today and it works. Deleting it in the same release that added
 * the generic one would have meant rewriting the front end under M3's schedule,
 * which badger-cash/branch-sdk-js#46 warned against in as many words.
 *
 * NOTHING HERE REACHES THE CHAIN ANY MORE. Every method delegates to
 * `client.tokens` or `client.types`; what remains is the mapping between car
 * names and declared identifiers, plus two projections. That mapping is the
 * thing that moves to the application, and when it has, this file is deleted
 * rather than maintained.
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
    const { typeId } = await this.client.types.current(LISTING_TYPE_SLUG);

    return await this.client.tokens.mint({
      typeId,
      stateName: ACTIVE_STATE,
      name: `${String(input.year)} ${input.make} ${input.model}`,
      durationDays: asActionInt(input.durationDays),
      note: 'listing published',
      // KEYED BY DECLARED IDENTIFIER, which is the whole move: the car names are
      // on this side and the generic client never learns them. `tokens.mint`
      // drops an undefined or empty value and keeps an explicit `false`, which
      // is the behaviour the pair builders here used to provide.
      text: {
        make: input.make,
        model: input.model,
        price_currency: input.priceCurrency,
        location: input.location,
        vin: input.vin,
        description: input.description,
        body_style: input.bodyStyle,
        transmission: input.transmission,
        fuel_type: input.fuelType,
        exterior_color: input.exteriorColor,
        condition: input.condition,
        title_status: input.titleStatus,
      },
      numbers: {
        price: input.price,
        year: input.year,
        mileage: input.mileage,
      },
      // An unanswered question writes no row and an explicit `false` writes one
      // saying so. Collapsing the two would tell a buyer somebody refused them
      // when nobody was asked.
      booleans: {
        accepts_offers: input.acceptsOffers,
        accepts_trade: input.acceptsTrade,
      },
      // `photos` is declared `json` and holds the object keys as one array,
      // because an identifier cannot repeat on one entity.
      json: { photos: input.photos ?? [] },
      // THE COMMITMENT, NEVER THE VALUE. `contact` is declared
      // `requires_custodian`, so the chain stores an HMAC and a custodian's name.
      brokered: { contact: input.contactHmacHex },
    });
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
    // The union is this directory's constraint, not the chain's: `tokens.close`
    // takes any state name and the chain validates it against the type.
    return await this.client.tokens.close(listingId, outcome);
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
    // THE STATE IS SUPPLIED HERE AND IS NOT AN ARGUMENT, which is the whole
    // reason this wrapper survives: offering a moderator a choice of terminal
    // state would let them file a takedown as 'sold'. Constraining it is a
    // product decision about THIS directory, so it lives on this side of the
    // adapter rather than in a client that must serve types nobody here knows.
    return await this.client.tokens.moderate(listingId, MODERATED_STATE, reason);
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
    const { typeId } = await this.client.types.current(LISTING_TYPE_SLUG);
    return await this.client.types.setFee(typeId, durationDays, fee);
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
    const record = await this.client.tokens.get(listingId);
    if (record === null) return null;

    const row: DetailRow = detailRowFrom(record);

    return {
      listingId: toUnits(row.listing_id, 'listing_id'),
      title: asText(row.title, 'title'),
      state: asText(row.state, 'state'),
      seller: asText(row.seller, 'seller'),
      make: asText(row.make, 'make'),
      model: asText(row.model, 'model'),
      year: Number(toUnits(row.year, 'year')),
      price: toAmount(row.price, METADATA_NUMERIC_SCALE, 'price'),
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

  async search(options: SearchOptions = {}): Promise<ListingSummary[]> {
    /*
      THE CAR NAMES ARE MAPPED HERE AND NOWHERE DEEPER. `tokens.search` takes
      `(identifier, value)` and `(identifier, min, max)` pairs, so everything
      this directory knows about an automobile lives in the three literals below
      and the generic client never learns any of it.
    */
    const text: TextFacet[] = [];
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
      if (value === undefined) continue;
      /*
        STILL FOLDED HERE, AND IT IS REDUNDANT. The node folds the needle itself
        per declaration — `CASE WHEN d.folded THEN lower(q.v) ELSE q.v END` — so
        `tokens.search` passes values through untouched (#53). Every automobile
        text facet happens to be declared folded, which makes lowercasing twice
        harmless, and keeping it holds this change to a purely structural one.

        It should go when the car vocabulary moves to the application
        (badger-cash/island-nook-directory-45#197): for a field declared UNfolded
        it would turn an exact search into one that can never match.
      */
      text.push({ identifier, value: value.toLowerCase() });
    }

    const ranges: RangeFacet[] = [];
    if (options.yearFrom !== undefined || options.yearTo !== undefined) {
      ranges.push({ identifier: 'year', min: options.yearFrom, max: options.yearTo });
    }
    if (options.maxPrice !== undefined) {
      ranges.push({ identifier: 'price', max: options.maxPrice });
    }

    // Flags filter only on true: "show me the ones open to offers" is a question,
    // "show me the ones that are not" is not one anybody asked.
    const booleans: BooleanFacet[] = [];
    if (options.acceptsOffers === true)
      booleans.push({ identifier: 'accepts_offers', value: true });
    if (options.acceptsTrade === true) booleans.push({ identifier: 'accepts_trade', value: true });

    const found = await this.client.tokens.search(LISTING_TYPE_SLUG, {
      text,
      ranges,
      booleans,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.after
        ? { after: { createdAt: options.after.listedAt, tokenId: options.after.listingId } }
        : {}),
    });

    // TWO ROUND TRIPS, NOT FOUR (#49). `token_fields` already carries
    // `custodian_url` per row, so there is no third call for a photo base.
    const fields = await this.client.tokens.fields(found.map((hit) => hit.tokenId));

    /*
      EXPIRED RECORDS ARE FILTERED HERE, and that is this directory's business
      rather than the generic client's. `search_tokens` excludes terminal STATES
      and knows nothing about deadlines, because a deadline is one directory's
      declared field and not a property of a token. A lapsed record is still
      `active` until the permissionless sweep moves it, so a grid that showed it
      would be advertising something whose term has run out.
    */
    const now = Math.floor(Date.now() / 1000);
    const out: ListingSummary[] = [];
    for (const hit of found) {
      const f = fields.get(String(hit.tokenId)) ?? new Map<string, TokenField>();
      const expires = f.get('expires_at')?.datetime;
      if (expires !== undefined && expires !== null && Number(expires) <= now) continue;
      out.push(this.toSummary(summaryRowFrom(hit, f)));
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
      `tokens.mine` RESOLVES THE CALLER ON CHAIN, which this used to do by hand:
      it joined `person_keys` on the address, and that is the one place the
      address-normalisation rule bites — `WHERE address = lower(@caller)`, because
      `@caller` for an EVM signer is EIP-55 checksummed while the column is
      lowercase. A bare comparison matches nothing, silently.
    */
    const found = await this.client.tokens.mine(LISTING_TYPE_SLUG, options);

    // The seller paid for the term, so this is the page that most needs it.
    const fields = await this.client.tokens.fields(found.map((hit) => hit.tokenId));

    return found.map((hit) => {
      const f = fields.get(String(hit.tokenId));
      return {
        listingId: hit.tokenId,
        title: hit.name,
        state: hit.state,
        listedAt: hit.createdAt,
        expiresAt: toOptionalDate(f?.get('expires_at')?.datetime ?? null),
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
      price: toAmount(row.price, METADATA_NUMERIC_SCALE, 'price'),
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
      DELEGATED. A rate card belongs to a token TYPE rather than to this
      directory (badger-cash/branch-sdk-js#55): every directory sets its own
      price to publish, and Government is curated rather than sold at all, so
      "what does publishing cost here" must be a question every type can answer.

      This stays as the automobile directory's way of asking, supplying its own
      slug rather than letting the callee assume one.
    */
    return await this.client.types.feeTiers(LISTING_TYPE_SLUG);
  }
}

function asActionInt(value: bigint | number): number {
  const asBig = typeof value === 'bigint' ? value : BigInt(value);
  return asQueryInt(asBig);
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
