import { toUnits } from './amount.js';
import { boolArray, intArray, numeric, numericArray, textArray } from './client.js';
import { asQueryInt, asText, clampLimit, decimalText } from './coerce.js';
import { BranchError } from './errors.js';

import type { BranchClient } from './client.js';

/*
  THE GENERIC TOKEN SURFACE: tokens of a type, addressed by slug.

  badger-cash/branch#56 stopped the chain knowing what a car is -- a directory
  is a token type created by transaction, its fields are declarations, its
  lifecycle is a state vocabulary. `listings.ts` has not made that move: it
  exports one hardcoded slug and names `make`, `model` and `vin` in its own
  types, so a second directory cannot use this package at all.

  This module is the move. Nothing here knows what a car is; what it knows is
  what the chain knows. `listings.ts` becomes a thin adapter over it (#56) and
  the car vocabulary moves to the application that is already about cars.

  WHAT THIS DELIBERATELY DOES NOT DO, because each is its own sub-issue:

    #52  discover a type's declared fields (`types.schema`). Until then a caller
         supplies identifiers it already knows.
    #53  read a type's state vocabulary rather than taking a state by name.
    #54  carry a per-field amount scale instead of a package constant.
    #55  address fee tiers by type.
*/

/** A `(identifier, value)` equality facet over a declared text field. */
export interface TextFacet {
  identifier: string;
  value: string;
}

/** A `(identifier, min, max)` facet over a declared numeric field. */
export interface RangeFacet {
  identifier: string;
  /** Omitted or undefined means unbounded below. */
  min?: string | number | undefined;
  /** Omitted or undefined means unbounded above. */
  max?: string | number | undefined;
}

/** A `(identifier, value)` facet over a declared boolean field. */
export interface BooleanFacet {
  identifier: string;
  value: boolean;
}

/** Where a page left off. Both halves are required: `created_at` alone is not unique. */
export interface TokenCursor {
  createdAt: Date;
  tokenId: bigint;
}

export interface TokenSearchOptions {
  text?: TextFacet[];
  ranges?: RangeFacet[];
  booleans?: BooleanFacet[];
  limit?: number;
  after?: TokenCursor;
  /**
   * A specific version of the type's ABI.
   *
   * Null, the default, resolves the family's current version. Pin it when a
   * caller must not silently read a newer ABI than it was written against.
   */
  typeVersion?: number | null;
}

/** One hit: identity only. Fields come from `fields()`, in one further call. */
export interface TokenHit {
  tokenId: bigint;
  name: string;
  state: string;
  createdAt: Date;
  typeId: number;
  typeVersion: number;
}

/**
 * One of the caller's own records, in any state.
 *
 * ADDS `isTerminal`, which a seller's page needs and a buyer's grid does not: a
 * seller must see what they withdrew, sold or let expire, and `is_terminal` is
 * how the chain says "this one is finished" without a client knowing what the
 * type calls its live state.
 */
export interface OwnTokenHit extends TokenHit {
  isTerminal: boolean;
}

/**
 * One declared field of one record, as stored.
 *
 * ONE VALUE IS SET AND THE REST ARE NULL, chosen by `datatype`. A brokered
 * field has no value at all -- it carries a commitment and the name of the
 * custodian who can answer for it, which is the whole point: every validator
 * holds every row permanently and reads are unauthenticated.
 */
export interface TokenField {
  identifier: string;
  datatype: string;
  text: string | null;
  number: string | null;
  boolean: boolean | null;
  datetime: number | null;
  json: string | null;
  /** Set only for a field whose declaration says `requires_custodian`. */
  hmacHex: string | null;
  /**
   * The custodian's NAME, which is what a page can honestly show for a brokered
   * field: who holds the details, never what they are.
   *
   * ONLY `get_token` RETURNS IT. `token_fields` carries `custodian_url` but not
   * the name, so this is null on a field that came from a batch read. That
   * asymmetry is the chain's and is not worth a second type: a grid shows a
   * photograph (which needs the url) and a detail page shows "ask CNMI Central"
   * (which needs the name).
   */
  custodianName: string | null;
  /** Where the custodian for this field answers, resolved from the declaration. */
  custodianUrl: string | null;
}

export interface TokenRecord {
  tokenId: bigint;
  name: string;
  state: string;
  isTerminal: boolean;
  typeId: number;
  typeSlug: string;
  typeVersion: number;
  createdAt: Date;
  /** The issuer's on-chain `display_name` -- the only name a human reads. */
  issuerPerson: string | null;
  issuerGroup: string | null;
  fields: Map<string, TokenField>;
}

export interface MintInput {
  typeId: number;
  /** A state this type declares. #53 will make the vocabulary discoverable. */
  stateName: string;
  name: string;
  /** Null resolves the caller's own holder from `@caller`. */
  toHolderId?: number | null;
  /** A group signing on behalf of an office. Refused unless the type allows it. */
  asGroupId?: number | null;
  settlementId?: number | null;
  durationDays?: number | null;
  note?: string;
  symbol?: string | null;
  quantity?: string | null;
  text?: Record<string, string | null | undefined>;
  numbers?: Record<string, string | number | undefined>;
  booleans?: Record<string, boolean | undefined>;
  datetimes?: Record<string, number | undefined>;
  json?: Record<string, unknown>;
  /** identifier -> HMAC hex. A brokered field never carries its value here. */
  brokered?: Record<string, string>;
}

interface HitRow {
  token_id: unknown;
  name: unknown;
  state: unknown;
  created_at: unknown;
  type_id: unknown;
  type_version: unknown;
}

interface OwnHitRow extends HitRow {
  is_terminal: unknown;
}

interface FieldRow {
  token_id: unknown;
  /** Absent from `token_fields`; present on `get_token`. */
  custodian_name?: unknown;
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

interface RecordRow extends FieldRow {
  name: unknown;
  type_slug: unknown;
  type_version: unknown;
  type_id: unknown;
  is_terminal: unknown;
  issuer_person: unknown;
  issuer_group: unknown;
  state: unknown;
  created_at: unknown;
  is_brokered: unknown;
}

/** An INT8 action parameter from either representation a caller holds. */
const idOf = (value: bigint | number): number =>
  asQueryInt(typeof value === 'bigint' ? value : BigInt(value));

/** An array parameter is sent only when it has elements; an empty one infers to `null[]`. */
const orNull = <T>(xs: T[]): T[] | null => (xs.length > 0 ? xs : null);

/*
  A NUMERIC ARRIVES AS A DECIMAL STRING OF THE VALUE, not as pre-scaled units --
  one of the three things the README says leaks through this package by design.
  So the string is kept as-is rather than parsed: turning '12750.0000000000' into
  a float to turn it back into a string is how precision goes missing.

  A number or bigint is accepted too, because `selectQuery` cannot declare types
  and an INT8 can arrive either way. Anything else is a row shape nobody expected
  and is worth a loud failure rather than '[object Object]'.
*/
const asNumberOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return v.toString();
  throw new BranchError(`expected a numeric value, received ${typeof v}`);
};

const asTextOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : asText(v, 'value');

function fieldFrom(row: FieldRow): TokenField {
  return {
    identifier: asText(row.identifier, 'identifier'),
    datatype: asText(row.datatype, 'datatype'),
    text: asTextOrNull(row.value_text),
    number: asNumberOrNull(row.value_number),
    boolean:
      row.value_boolean === null || row.value_boolean === undefined
        ? null
        : Boolean(row.value_boolean),
    datetime:
      row.value_datetime === null || row.value_datetime === undefined
        ? null
        : Number(row.value_datetime),
    json: asTextOrNull(row.value_json),
    hmacHex: asTextOrNull(row.value_hmac),
    custodianName: asTextOrNull(row.custodian_name),
    custodianUrl: asTextOrNull(row.custodian_url),
  };
}

export class TokensClient {
  constructor(private readonly client: BranchClient) {}

  /**
   * Records of a type, newest first, filtered by facets.
   *
   * UNSIGNED. `search_tokens` reads no `@caller`, so this reaches the chain
   * through an unsigned call and an anonymous visitor can browse. That property
   * is what `readonly.test.ts` exists to protect.
   */
  async search(typeSlug: string, options: TokenSearchOptions = {}): Promise<TokenHit[]> {
    const limit = clampLimit(options.limit);

    /*
      NEEDLES ARE PASSED THROUGH, NOT LOWERCASED, and this corrects what
      `listings.search` does.

      The node folds the needle itself, per declaration:
      `m.value_text = CASE WHEN d.folded THEN lower(q.v) ELSE q.v END`. So
      lowercasing here is redundant for a folded field and WRONG for one
      declared unfolded -- it would turn an exact search into a search that can
      never match. Every car text facet happens to be folded, which is why the
      client-side fold has been harmless rather than correct.

      Trimmed, though: '   ' is not a value anybody chose, and sending it would
      add a facet that matches nothing.
    */
    const textKeys: string[] = [];
    const textValues: string[] = [];
    for (const facet of options.text ?? []) {
      const value = facet.value.trim();
      if (value === '') continue;
      textKeys.push(facet.identifier);
      textValues.push(value);
    }

    /*
      BOUNDS TRAVEL AS DECIMAL STRINGS and the action casts them.

      They cannot be NUMERIC(38,10)[] from a client, which only a running node
      revealed. Nothing infers to NUMERIC, so an undeclared [2021] arrives as
      int8[] and is refused; declare the type and an array whose elements are
      ALL NULL arrives as numeric(0,0)[] and is refused anyway -- which is
      exactly what a caller filtering `year >= 2015` with no upper bound
      produces. The common case was the broken one and it passed a unit test
      against a fake.

      Text has none of it: text infers as text, a NULL element stays NULL, and
      the precision is stated in the action rather than guessed from a value.
    */
    const numberKeys: string[] = [];
    const numberMins: Array<string | null> = [];
    const numberMaxs: Array<string | null> = [];
    for (const facet of options.ranges ?? []) {
      if (facet.min === undefined && facet.max === undefined) continue;
      numberKeys.push(facet.identifier);
      numberMins.push(
        facet.min === undefined ? null : decimalText(facet.min, `${facet.identifier} min`)
      );
      numberMaxs.push(
        facet.max === undefined ? null : decimalText(facet.max, `${facet.identifier} max`)
      );
    }

    const booleanKeys: string[] = [];
    const booleanValues: boolean[] = [];
    for (const facet of options.booleans ?? []) {
      booleanKeys.push(facet.identifier);
      booleanValues.push(facet.value);
    }

    const rows = await this.client.readPublic<HitRow>('search_tokens', {
      $type_slug: typeSlug,
      $text_keys: orNull(textKeys),
      $text_values: orNull(textValues),
      $limit: limit,
      $after_created_at: options.after
        ? asQueryInt(BigInt(Math.floor(options.after.createdAt.getTime() / 1000)))
        : null,
      $after_id: options.after ? asQueryInt(options.after.tokenId) : null,
      $type_version: options.typeVersion ?? null,
      $number_keys: orNull(numberKeys),
      $number_mins: orNull(numberMins),
      $number_maxs: orNull(numberMaxs),
      $boolean_keys: orNull(booleanKeys),
      $boolean_values: orNull(booleanValues),
    });

    return rows.map((row) => ({
      tokenId: toUnits(row.token_id, 'token_id'),
      name: asText(row.name, 'name'),
      state: asText(row.state, 'state'),
      createdAt: new Date(Number(row.created_at) * 1000),
      typeId: Number(row.type_id),
      typeVersion: Number(row.type_version),
    }));
  }

  /**
   * The declared fields of many records, in one call.
   *
   * THE SECOND OF TWO ROUND TRIPS, and there must not be a third. `token_fields`
   * already carries `custodian_url` per row, resolved from the declaration
   * governing each record's own type, so a caller never needs a separate lookup
   * to render a photograph. A grid that resolves a custodian per card is the
   * regression badger-cash/branch-sdk-js#49 removed -- four round trips became
   * two, and on a WAN each one is a latency rather than 8ms of query time.
   */
  async fields(tokenIds: bigint[]): Promise<Map<string, Map<string, TokenField>>> {
    const byToken = new Map<string, Map<string, TokenField>>();
    if (tokenIds.length === 0) return byToken;

    const rows = await this.client.readPublic<FieldRow>('token_fields', {
      $token_ids: tokenIds.map((id) => asQueryInt(id)),
    });

    for (const row of rows) {
      const key = String(toUnits(row.token_id, 'token_id'));
      let fields = byToken.get(key);
      if (fields === undefined) {
        fields = new Map<string, TokenField>();
        byToken.set(key, fields);
      }
      const field = fieldFrom(row);
      fields.set(field.identifier, field);
    }
    return byToken;
  }

  /**
   * One record with every declared field, in a single call.
   *
   * `get_token` RETURNS LONG FORMAT: one row per field, the record's identity
   * repeated on each. It also carries `custodian_url`, which badger-cash/branch#122
   * added precisely so a detail page costs one round trip rather than three.
   */
  async get(tokenId: bigint | number): Promise<TokenRecord | null> {
    const rows = await this.client.readPublic<RecordRow>('get_token', {
      $token_id: idOf(tokenId),
    });
    if (rows.length === 0) return null;

    const head = rows[0];
    if (head === undefined) return null;

    const fields = new Map<string, TokenField>();
    for (const row of rows) {
      // A record with no declared fields still returns one row, with a null
      // identifier. Skipping it is the difference between an empty map and a
      // throw from `asText`.
      if (row.identifier === null || row.identifier === undefined) continue;
      const field = fieldFrom(row);
      fields.set(field.identifier, field);
    }

    return {
      tokenId: toUnits(head.token_id, 'token_id'),
      name: asText(head.name, 'name'),
      state: asText(head.state, 'state'),
      isTerminal: Boolean(head.is_terminal),
      typeId: Number(head.type_id),
      typeSlug: asText(head.type_slug, 'type_slug'),
      typeVersion: Number(head.type_version),
      createdAt: new Date(Number(head.created_at) * 1000),
      issuerPerson: asTextOrNull(head.issuer_person),
      issuerGroup: asTextOrNull(head.issuer_group),
      fields,
    };
  }

  /**
   * Issue a record of a type, with values keyed by declared identifier.
   *
   * AN ABSENT KEY AND AN EXPLICIT `false` ARE DIFFERENT THINGS. Omitting a
   * boolean writes no row; passing `false` writes one saying so. Collapsing them
   * would tell a reader somebody refused when nobody was asked.
   */
  async mint(input: MintInput): Promise<string> {
    const textKeys: string[] = [];
    const textValues: string[] = [];
    for (const [identifier, value] of Object.entries(input.text ?? {})) {
      if (value === undefined || value === null) continue;
      const trimmed = value.trim();
      if (trimmed === '') continue;
      textKeys.push(identifier);
      textValues.push(trimmed);
    }

    const numberKeys: string[] = [];
    const numberValues: string[] = [];
    for (const [identifier, value] of Object.entries(input.numbers ?? {})) {
      if (value === undefined) continue;
      numberKeys.push(identifier);
      numberValues.push(decimalText(value, identifier));
    }

    const booleanKeys: string[] = [];
    const booleanValues: boolean[] = [];
    for (const [identifier, value] of Object.entries(input.booleans ?? {})) {
      if (value === undefined) continue;
      booleanKeys.push(identifier);
      booleanValues.push(value);
    }

    const datetimeKeys: string[] = [];
    const datetimeValues: number[] = [];
    for (const [identifier, value] of Object.entries(input.datetimes ?? {})) {
      if (value === undefined) continue;
      datetimeKeys.push(identifier);
      datetimeValues.push(value);
    }

    const jsonKeys: string[] = [];
    const jsonValues: string[] = [];
    for (const [identifier, value] of Object.entries(input.json ?? {})) {
      if (value === undefined) continue;
      jsonKeys.push(identifier);
      jsonValues.push(JSON.stringify(value));
    }

    const brokeredKeys: string[] = [];
    const brokeredHmacs: string[] = [];
    for (const [identifier, hmac] of Object.entries(input.brokered ?? {})) {
      if (hmac === undefined) continue;
      if (!/^[0-9a-fA-F]+$/.test(hmac)) {
        throw new BranchError(
          `${identifier} commitment must be hex, received ${JSON.stringify(hmac)}`
        );
      }
      brokeredKeys.push(identifier);
      brokeredHmacs.push(hmac);
    }

    return await this.client.write(
      'mint_token',
      {
        $type_id: input.typeId,
        $state_name: input.stateName,
        $name: input.name,
        $to_holder_id: input.toHolderId ?? null,
        $as_group_id: input.asGroupId ?? null,
        $settlement_id: input.settlementId ?? null,
        $duration_days: input.durationDays ?? null,
        $symbol: input.symbol ?? null,
        $quantity: input.quantity ?? null,
        $note: input.note ?? null,
        // EMPTY ARRAYS RATHER THAN NULL for the field pairs: `mint_token`
        // iterates them, and a declared empty array is the honest "no fields of
        // this kind". The declarations below are what stop [] inferring to null[].
        $text_keys: textKeys,
        $text_values: textValues,
        $number_keys: numberKeys,
        $number_values: numberValues,
        $boolean_keys: booleanKeys,
        $boolean_values: booleanValues,
        $datetime_keys: datetimeKeys,
        $datetime_values: datetimeValues,
        $json_keys: jsonKeys,
        $json_values: jsonValues,
        $brokered_keys: brokeredKeys,
        $brokered_hmacs: brokeredHmacs,
      },
      {
        // Nothing infers to NUMERIC, and an empty array infers to `null[]`. All
        // twelve are declared rather than only the ones that obviously cannot
        // infer -- see client.ts's note on `textArray`.
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

  /*
    STATE NAMES ARE PARAMETERS, NOT LITERALS -- badger-cash/branch-sdk-js#53.

    `listings.ts` froze one type's vocabulary into the package: `ACTIVE_STATE`,
    `MODERATED_STATE` and `ListingOutcome = 'sold' | 'withdrawn'`. An event is
    `cancelled` and a business is `closed`, and neither is expressible that way.

    THE CHAIN VALIDATES, SO THIS DOES NOT. `close_token` and `moderate_token`
    both resolve the name through `type_state($type_id, $state_name)`, which
    errors with `this type has no state named X`. That arrives as an
    ActionFailedError whose `log` is the message worth showing a user.

    So there is deliberately no client-side check here. A second implementation
    of a rule the chain owns is a rule that can disagree with the chain, which is
    worse than no check -- the same reason #52 does not re-apply declaration
    precedence that `token_type_schema` already applies.
  */

  /**
   * End a record, as its owner.
   *
   * AUTHORITY IS OWNERSHIP, not an office: the person whose `issuer_person_id`
   * is on the record, and nobody else. The target state must be one this type
   * declares and must be terminal; both are the chain's checks.
   */
  /**
   * The caller's own records of a type, in every state.
   *
   * SIGNED, unlike `search`, because `my_tokens` resolves `@caller`. That is also
   * why it is not filtered to live records: a seller needs to see what they
   * withdrew, sold or let expire.
   *
   * THE CALLER RESOLUTION IS THE CHAIN'S, which matters more than it looks.
   * Doing it here would mean joining `person_keys` on the address, and `@caller`
   * for an EVM signer is EIP-55 checksummed while `person_keys.address` is
   * lowercase — so a bare comparison matches nothing, silently. That is the most
   * repeated trap in this schema and not a client's to keep.
   */
  async mine(typeSlug: string, options: { limit?: number } = {}): Promise<OwnTokenHit[]> {
    const rows = await this.client.read<OwnHitRow>('my_tokens', {
      $type_slug: typeSlug,
      $limit: clampLimit(options.limit),
    });
    return rows.map((row) => ({
      tokenId: toUnits(row.token_id, 'token_id'),
      name: asText(row.name, 'name'),
      state: asText(row.state, 'state'),
      isTerminal: Boolean(row.is_terminal),
      createdAt: new Date(Number(row.created_at) * 1000),
      typeId: Number(row.type_id),
      typeVersion: Number(row.type_version),
    }));
  }

  async close(tokenId: bigint | number, stateName: string): Promise<string> {
    return await this.client.write('close_token', {
      $token_id: idOf(tokenId),
      $state_name: stateName,
    });
  }

  /**
   * Take a record down, as the office the type nominates.
   *
   * NOT `close`, and the chain records them differently: this writes a
   * `moderated` event carrying the acting role and the reason, so a takedown is
   * attributable afterwards to the office that made it. Authority is read from
   * the TYPE -- `token_types.burning_role_id` -- so it is whatever office that
   * type nominates rather than a fixed one.
   *
   * The reason is mandatory and the action refuses an empty one: a takedown
   * nobody has to justify is a takedown nobody can review.
   *
   * THE STATE IS AN ARGUMENT HERE AND IS NOT IN `listings.moderate`, which is
   * the right split rather than an inconsistency. Offering a moderator a choice
   * of terminal state would let them file a takedown as 'sold'; constraining it
   * to one is a PRODUCT decision about a particular directory, so it belongs in
   * the adapter that knows which directory it is -- not in a client that must
   * serve a type whose takedown state nobody here has heard of.
   */
  async moderate(tokenId: bigint | number, stateName: string, reason: string): Promise<string> {
    return await this.client.write('moderate_token', {
      $token_id: idOf(tokenId),
      $state_name: stateName,
      $reason: reason,
    });
  }

  /**
   * Retire a record whose paid term has run out.
   *
   * NO STATE NAME, and that is the action's shape rather than an omission:
   * `expire_token` reads the type's own configured expiry state through
   * `type_expiry_state`, so which state means "expired" is configuration on the
   * type instead of a caller's choice.
   *
   * PERMISSIONLESS BY DESIGN. Anyone may sweep a lapsed record, because a term
   * that has run out should not depend on its seller to admit it.
   */
  async expire(tokenId: bigint | number): Promise<string> {
    return await this.client.write('expire_token', { $token_id: idOf(tokenId) });
  }
}
