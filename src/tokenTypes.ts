import { METADATA_NUMERIC_SCALE, roundToWholeCredits, toAmount, toUnits } from './amount.js';
import { boolArray, intArray, intType, numeric, textArray } from './client.js';
import { asQueryInt, asText, decimalText } from './coerce.js';
import { BranchError } from './errors.js';

import type { CreditAmount } from './amount.js';
import type { BranchClient } from './client.js';

/*
  WHAT A TYPE DECLARES: the keystone of badger-cash/branch-sdk-js#46.

  `tokens.ts` stopped this package knowing what a car is, but a caller still has
  to know which identifiers exist to search or mint. Without a way to ASK, every
  consumer re-hardcodes exactly what the SDK just stopped hardcoding, and the
  problem moves rather than goes away.

  This is the asking. A directory's filter chrome becomes GENERATED from what the
  chain says the type declares, which is what makes adding a directory
  configuration rather than a sixth front end
  (badger-cash/island-nook-directory-45#187).

  NAMED tokenTypes.ts RATHER THAN types.ts. The client is `client.types`, which
  follows this package's one-file-per-client convention, but a file called
  `types.ts` in a TypeScript project reads as "shared type aliases" and someone
  would eventually put them here.

  THE NODE ALREADY MERGES SHARED DECLARATIONS, so this does not. A field declared
  at `token_type_id IS NULL` applies to every type, and a type-scoped declaration
  of the same identifier takes precedence -- `token_type_schema` applies that rule
  in SQL with a correlated NOT EXISTS. Re-applying it here would be a second
  implementation of a precedence rule that the chain's own comment warns is
  already stated in three places.
*/

/** Mirrors `metadata_schemas_datatype_vocab`. */
export type FieldDatatype = 'text' | 'number' | 'boolean' | 'datetime' | 'json' | 'uri';

/**
 * Mirrors `metadata_schemas_scope_vocab`.
 *
 * `'class'` is spelled the old way on purpose: it is a VALUE in existing rows
 * rather than an identifier, so #56's rename left it alone. `'type_active'`
 * means unique among records of this type whose current state is not terminal --
 * the "unique among ACTIVE listings" rule that the other three cannot express.
 */
export type FieldUniqueScope = 'none' | 'class' | 'global' | 'type_active';

/** One declared field of a type, as the chain describes it. */
export interface DeclaredField {
  identifier: string;
  datatype: FieldDatatype;
  /** Human-readable, and the translation key a generated filter should use. */
  label: string;
  required: boolean;
  /**
   * Whether this field is brokered.
   *
   * A brokered field is stored as an HMAC plus a named custodian, never as a
   * value. A generated page must render it as "ask the custodian" rather than as
   * a blank, because a blank looks like missing data when it is a commitment.
   */
  requiresCustodian: boolean;
  uniqueScope: FieldUniqueScope;
  /** The custodian named on the DECLARATION, which may name one without brokering. */
  custodianGroupId: number | null;
  custodianPersonId: number | null;
}

/**
 * One duration a type sells, and what it costs.
 *
 * ADDRESSED BY TYPE, NOT BY THE LISTINGS CLIENT. Each directory sets its own
 * price to publish, and Government is curated rather than sold at all — so
 * "what does it cost to publish here" must be a question every type can answer,
 * not one only the automobile directory can ask.
 *
 * The rate is a metadata row on the type — `fee_30d`, `fee_180d` — precisely so
 * the admin office can reprice by transaction instead of by redeploy. A client
 * that hardcodes "30 days costs 1 credit" shows the wrong price the day after a
 * repricing, and the ledger is the only thing that would disagree with it.
 */
export interface FeeTier {
  /** Days the record stays active. `mint_token` takes this as `$duration_days`. */
  readonly durationDays: number;
  /**
   * The charge in WHOLE CREDITS, as the chain computes it.
   *
   * SCALE 0, NOT 10, and the difference is the whole reason this is not a bare
   * read of the column. The stored rate is `NUMERIC(38,10)` but `listing_fee`
   * returns `NUMERIC(78,0)`, and the ledger it is charged against has scale 0.
   * Handing back the scale-10 figure produces `units` a thousand million times
   * larger than a balance's, and the comparison then passes on an empty account.
   *
   * That rounding was dropped once during the move to view actions and the fee
   * tests caught it, which is why it is spelled out here.
   */
  readonly fee: CreditAmount;
}

/** Which version of a family is live, and what it is called. */
export interface TypeVersion {
  typeId: number;
  typeSlug: string;
  typeVersion: number;
  name: string;
}

export interface TypeSchema extends TypeVersion {
  /** Ordered by identifier, as the action returns them. */
  fields: DeclaredField[];
}

interface VersionRow {
  type_id: unknown;
  type_version: unknown;
  type_slug: unknown;
  name: unknown;
}

interface FieldRow {
  identifier: unknown;
  datatype: unknown;
  label: unknown;
  required: unknown;
  requires_custodian: unknown;
  unique_scope: unknown;
  custodian_group_id: unknown;
  custodian_person_id: unknown;
}

/** An INT8 action parameter from either representation a caller holds. */
const idOf = (value: bigint | number): number =>
  asQueryInt(typeof value === 'bigint' ? value : BigInt(value));

function toDatatype(value: unknown): FieldDatatype {
  if (
    value === 'text' ||
    value === 'number' ||
    value === 'boolean' ||
    value === 'datetime' ||
    value === 'json' ||
    value === 'uri'
  ) {
    return value;
  }
  throw new BranchError(`unrecognised field datatype ${JSON.stringify(value)}`);
}

function toUniqueScope(value: unknown): FieldUniqueScope {
  if (value === 'none' || value === 'class' || value === 'global' || value === 'type_active') {
    return value;
  }
  throw new BranchError(`unrecognised unique scope ${JSON.stringify(value)}`);
}

const toIdOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : asQueryInt(toUnits(value, 'custodian id'));

function fieldFrom(row: FieldRow): DeclaredField {
  return {
    identifier: asText(row.identifier, 'identifier'),
    datatype: toDatatype(row.datatype),
    label: asText(row.label, 'label'),
    required: Boolean(row.required),
    requiresCustodian: Boolean(row.requires_custodian),
    uniqueScope: toUniqueScope(row.unique_scope),
    custodianGroupId: toIdOrNull(row.custodian_group_id),
    custodianPersonId: toIdOrNull(row.custodian_person_id),
  };
}

/*
  DECLARING A DIRECTORY -- badger-cash/branch-sdk-js#67.

  Everything above reads a type. These create one, which is what makes a second
  directory configuration in a consuming application rather than a script in the
  node repository (badger-cash/island-nook-directory-45#186).

  `create_token_type` RETURNS NO ID. `branch/scripts/seed-cars.sh` reads it back
  with a SELECT on `token_types`; a consumer of this package never SELECTs a chain
  table, so `create` resolves it through `current()` instead -- which also means
  the id you get is the one `live_slug` resolves to, rather than whatever a raw
  query happened to return.
*/

/** What a token type is, at the moment it is created. */
export interface CreateTypeInput {
  /** Canonical lowercase. Becomes the family's `live_slug`. */
  slug: string;
  name: string;
  description: string;
  /**
   * The office that may change this type's own configuration.
   *
   * Null leaves it with the creating organization's admin office, which is what
   * a directory normally wants.
   */
  governingRoleId?: number | null;
  /** The office `moderate_token` requires. Null means nobody can take a record down. */
  moderatingRoleId?: number | null;
  /**
   * Who may issue a record.
   *
   * `'office'` is the default on chain and the one Government needs -- an issue
   * with no signing office is refused by CHECK. A classified directory wants
   * `'person'` or `'either'`.
   */
  issuerKind: 'office' | 'person' | 'either';
  isFungible?: boolean;
  transferable?: boolean;
  visibility?: string;
  /** The state a new record starts in. A type must have at least one. */
  initialStateName: string;
  initialStateLabel: string;
  /** How issuing is paid for, e.g. `'fee'`. */
  mintPolicy: string;
}

/** One field a type declares. */
export interface DeclareFieldInput {
  identifier: string;
  datatype: FieldDatatype;
  label: string;
  required?: boolean;
  uniqueScope?: FieldUniqueScope;
  /** Brokered: the chain stores an HMAC and a custodian, never a value. */
  brokered?: boolean;
  /** The custodian for this field. Required when brokered; allowed without it. */
  custodianGroupId?: number | null;
  /**
   * Whether a text value is stored lowercased.
   *
   * DECLARE IT OR FILTERS SILENTLY MATCH NOTHING. `make` and `model` fold so a
   * filter is a bare equality on the lookup index; `location` and `description`
   * do not. This was an unwritten convention inside one directory's bespoke write
   * action before badger-cash/branch#56 made it data, which meant a directory
   * whose author did not know it got filters that matched nothing and errored
   * nowhere.
   */
  folded?: boolean;
}

/** One state in a type's lifecycle vocabulary. */
export interface AddStateInput {
  name: string;
  label: string;
  /** Lower sorts first. `mint_token` resolves the lowest non-terminal when handed a null state. */
  ordinal: number;
  /** Terminal states are excluded from `search_tokens` and end a record's life. */
  isTerminal: boolean;
}

export class TypesClient {
  constructor(private readonly client: BranchClient) {}

  /**
   * The live version of a family.
   *
   * NOTHING IS CACHED HERE, deliberately, and that settles
   * badger-cash/branch-sdk-js#44. `listings.ts` caches one type id for the
   * client's lifetime, which pins a page to whichever version was live when it
   * loaded. A schema is fetched once per page render rather than once per card,
   * so the call is cheap and the staleness is not worth buying.
   */
  async current(family: string): Promise<TypeVersion> {
    const rows = await this.client.readPublic<VersionRow>('current_type_version', {
      $family: family,
    });
    const row = rows[0];
    if (row === undefined) {
      throw new BranchError(`no live token type for the family ${JSON.stringify(family)}`);
    }
    return {
      typeId: asQueryInt(toUnits(row.type_id, 'type_id')),
      typeVersion: asQueryInt(toUnits(row.type_version, 'type_version')),
      typeSlug: asText(row.type_slug, 'type_slug'),
      name: asText(row.name, 'name'),
    };
  }

  /**
   * What a family's live version declares.
   *
   * TWO CALLS, AND THE SECOND IS NOT A ROUND TRIP WORTH REMOVING.
   * `token_type_schema` resolves the slug internally but returns only the
   * declarations -- no id and no version number -- and a caller needs the id to
   * mint and the version to pin. So the version is fetched alongside.
   *
   * This is a once-per-page cost rather than a per-record one, which is the
   * distinction that mattered in #49: there, four round trips per GRID were the
   * whole of a slowdown. A schema is fetched once and reused for every card.
   */
  async schema(family: string): Promise<TypeSchema> {
    const [version, rows] = await Promise.all([
      this.current(family),
      this.client.readPublic<FieldRow>('token_type_schema', { $type_slug: family }),
    ]);
    return { ...version, fields: rows.map(fieldFrom) };
  }

  /**
   * What ONE version declares, by type id.
   *
   * `schema()` answers for whichever version is current, which is the right
   * default and the wrong answer for a client holding an older record: handing
   * it the current ABI would tell it a field exists that the record cannot have,
   * or hide one it does. `get_token` returns the record's own `type_id`, so this
   * takes that.
   */
  async versionSchema(typeId: bigint | number): Promise<DeclaredField[]> {
    const id = typeof typeId === 'bigint' ? typeId : BigInt(typeId);
    const rows = await this.client.readPublic<FieldRow>('token_version_schema', {
      $type_id: asQueryInt(id),
    });
    return rows.map(fieldFrom);
  }

  /**
   * The durations a type sells, cheapest first.
   *
   * UNSIGNED, so a seller can be shown what publishing costs before they have
   * signed anything.
   *
   * THE IDENTIFIER GRAMMAR LIVES HERE AND THAT IS DELIBERATE. `fee_identifier`
   * on chain builds `'fee_' || days || 'd'` but is `PRIVATE VIEW`, so a client
   * cannot call it; the regex below is its inverse and a regex is the right tool
   * for that. It says exactly what a tier identifier is rather than matching
   * with LIKE — `_` is a single-character wildcard, so the obvious `fee_%d` also
   * matches `feeXd`. A row that does not parse is skipped rather than guessed at.
   *
   * A TYPE WITH NO FEE RETURNS AN EMPTY ARRAY, which is not the same as a fee of
   * zero. Government is curated rather than sold, so "no tiers" is the honest
   * answer and a caller must be able to tell it from "free".
   */
  async feeTiers(family: string): Promise<FeeTier[]> {
    const rows = await this.client.readPublic<{ identifier: unknown; fee: unknown }>(
      'type_fee_tiers',
      { $type_slug: family }
    );

    const tiers: FeeTier[] = [];
    for (const row of rows) {
      const identifier = typeof row.identifier === 'string' ? row.identifier : '';
      const match = /^fee_(\d+)d$/.exec(identifier);
      if (!match) continue;
      tiers.push({
        durationDays: Number(match[1]),
        fee: roundToWholeCredits(toAmount(row.fee, METADATA_NUMERIC_SCALE, identifier), identifier),
      });
    }
    tiers.sort((a, b) => a.durationDays - b.durationDays);
    return tiers;
  }

  /**
   * Set what publishing costs for a given duration.
   *
   * A DIFFERENT OFFICE FROM MODERATION, and the chain separates them: this needs
   * the governing organization's admin office, while `moderate_token` needs the
   * type's `burning_role_id`. Taking a record down and changing what records cost
   * are not the same authority, so a UI treating "holds an office" as one thing
   * will offer this to somebody the node refuses.
   *
   * TAKES A TYPE ID, not a slug, because a reprice must land on a specific
   * version rather than on whichever is live when the transaction arrives.
   */
  async setFee(
    typeId: bigint | number,
    durationDays: bigint | number,
    fee: string | number
  ): Promise<string> {
    return await this.client.write(
      'set_type_fee',
      {
        $type_id: asQueryInt(typeof typeId === 'bigint' ? typeId : BigInt(typeId)),
        $duration_days: asQueryInt(
          typeof durationDays === 'bigint' ? durationDays : BigInt(durationDays)
        ),
        $fee: decimalText(fee, 'fee'),
      },
      // Nothing infers to NUMERIC.
      { $fee: numeric(38, 10) }
    );
  }

  /**
   * Create a token type: a directory.
   *
   * RESOLVES THE ID THROUGH `current()`, because `create_token_type` returns
   * nothing and a consumer of this package never SELECTs a chain table.
   *
   * Requires the `create_token_type` permission, which the operating
   * organization's admin office holds.
   */
  async create(input: CreateTypeInput): Promise<TypeVersion> {
    await this.client.write(
      'create_token_type',
      {
        $slug: input.slug,
        $name: input.name,
        $description: input.description,
        $governing_role_id: input.governingRoleId ?? null,
        $moderating_role_id: input.moderatingRoleId ?? null,
        $issuer_kind: input.issuerKind,
        $is_fungible: input.isFungible ?? false,
        $transferable: input.transferable ?? false,
        $visibility: input.visibility ?? 'public',
        $initial_state_name: input.initialStateName,
        $initial_state_label: input.initialStateLabel,
        $mint_policy: input.mintPolicy,
      },
      // An INT8 that may be null still needs its type declared; nothing infers.
      { $governing_role_id: intType, $moderating_role_id: intType }
    );
    return await this.current(input.slug);
  }

  /** Add a state to a type's vocabulary. */
  async addState(typeId: bigint | number, state: AddStateInput): Promise<string> {
    return await this.client.write(
      'add_type_state',
      {
        $type_id: idOf(typeId),
        $name: state.name,
        $label: state.label,
        // `token_type_states.ordinal` is INT4, but an action signature CANNOT say
        // INT4 -- it declares INT8 and casts (branch, gotcha 5).
        $ordinal: state.ordinal,
        $is_terminal: state.isTerminal,
      },
      { $ordinal: intType }
    );
  }

  /**
   * Declare a type's fields, in one transaction.
   *
   * NINE PARALLEL ARRAYS, which is the action's shape: `declare_type_fields`
   * takes identifiers, datatypes, labels, required, unique scopes, brokered
   * flags, custodian groups and folded flags, matched by position. Every one is
   * type-declared, because nothing infers and an empty array infers to `null[]`.
   *
   * ONE TRANSACTION FOR ALL OF THEM, deliberately: twenty fields declared
   * separately would be twenty transactions and the officeholder key can sign
   * only one at a time (#11).
   */
  async declareFields(
    typeId: bigint | number,
    fields: readonly DeclareFieldInput[]
  ): Promise<string> {
    if (fields.length === 0) {
      throw new BranchError('declareFields needs at least one field');
    }
    return await this.client.write(
      'declare_type_fields',
      {
        $type_id: idOf(typeId),
        $identifiers: fields.map((f) => f.identifier),
        $datatypes: fields.map((f) => f.datatype),
        $labels: fields.map((f) => f.label),
        $required: fields.map((f) => f.required ?? false),
        $unique_scopes: fields.map((f) => f.uniqueScope ?? 'none'),
        $brokered: fields.map((f) => f.brokered ?? false),
        $custodian_groups: fields.map((f) =>
          f.custodianGroupId === undefined || f.custodianGroupId === null
            ? null
            : asQueryInt(BigInt(f.custodianGroupId))
        ),
        $folded: fields.map((f) => f.folded ?? false),
      },
      {
        $identifiers: textArray,
        $datatypes: textArray,
        $labels: textArray,
        $required: boolArray,
        $unique_scopes: textArray,
        $brokered: boolArray,
        $custodian_groups: intArray,
        $folded: boolArray,
      }
    );
  }

  /**
   * Attach a validation rule, or a brokered field's structure template.
   *
   * TWO MEANINGS, ONE COLUMN. For an ordinary field this is a validation rule.
   * For a brokered one it is the STRUCTURE TEMPLATE of the plaintext the
   * custodian holds — and the on-chain value is an HMAC over that structure, so
   * a template must never be redefined in place. Version it and re-hash, or every
   * existing commitment silently stops verifying.
   *
   * NOTHING ENFORCES A VALIDATION RULE ON WRITE today. It is declarative
   * metadata, which makes it a UI hint rather than a constraint.
   */
  async setFieldValidation(
    typeId: bigint | number,
    identifier: string,
    validation: string
  ): Promise<string> {
    return await this.client.write('set_field_validation', {
      $type_id: idOf(typeId),
      $identifier: identifier,
      $validation: validation,
    });
  }

  /**
   * Name the state a lapsed record moves to.
   *
   * `expire_token` reads this rather than taking a state, so which state means
   * "expired" is configuration on the type instead of a caller's choice.
   */
  async setExpiryState(typeId: bigint | number, stateName: string): Promise<string> {
    return await this.client.write('set_type_expiry_state', {
      $type_id: idOf(typeId),
      $state_name: stateName,
    });
  }

  /** Name the holder that collects this type's fees. */
  async setFeeHolder(typeId: bigint | number, holderId: bigint | number): Promise<string> {
    return await this.client.write('set_type_fee_holder', {
      $type_id: idOf(typeId),
      $holder_id: idOf(holderId),
    });
  }

  /**
   * Declare a duration the network sells, so a type may price it.
   *
   * NETWORK-WIDE RATHER THAN PER TYPE: a term is a duration anybody may charge
   * for, and `setFee` prices one for a given type. Declaring 30 days once lets
   * every directory offer it.
   */
  async declareFeeDuration(durationDays: bigint | number): Promise<string> {
    return await this.client.write(
      'declare_fee_duration',
      { $duration_days: idOf(durationDays) },
      { $duration_days: intType }
    );
  }
}
