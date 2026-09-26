import { authTypeOf, canonicalAddress } from './address.js';

import type { AuthType, CanonicalAddress } from './address.js';
import type { BranchClient } from './client.js';

/** The caller's own record, as `whoami` returns it. */
export interface Person {
  personId: bigint;
  handle: string;
  displayName: string;
  holderId: bigint;
}

/**
 * Where a key stands.
 *
 * `pending` -- proposed, but nobody has proved control of it yet, so it cannot
 * act. `active` -- confirmed and usable. **`revoked` is terminal.** There is
 * no transition out of it: `person_keys` is append-only history rather than
 * state, and re-enabling a revoked key is not expressible in the action layer
 * by design. See `revokeKey`.
 */
export type KeyStatus = 'pending' | 'active' | 'revoked';

/** One key on the caller's account. */
export interface KeyRecord {
  address: CanonicalAddress;
  authType: AuthType;
  label: string | null;
  status: KeyStatus;
  addedAt: Date;
}

/** kwil returns INT8 as a number or a string depending on magnitude. */
function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
  throw new TypeError(`expected an integer for ${field}, received ${typeof value}`);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`expected text for ${field}, received ${typeof value}`);
  }
  return value;
}

function toStatus(value: unknown): KeyStatus {
  if (value === 'pending' || value === 'active' || value === 'revoked') return value;
  throw new TypeError(`unrecognised key status ${JSON.stringify(value)}`);
}

interface WhoamiRow {
  person_id: unknown;
  handle: unknown;
  display_name: unknown;
  holder_id: unknown;
}

interface KeyRow {
  address: unknown;
  auth_type: unknown;
  label: unknown;
  status: unknown;
  added_at: unknown;
}

/**
 * Registration, the caller's own record, and key lifecycle.
 *
 * Wraps `21-identity.sql`. Every write confirms its on-chain result code
 * before returning, so a refusal arrives as an exception rather than as a
 * transaction hash that happens to mean nothing.
 */
/**
 * An office the caller currently holds.
 *
 * AN OFFICE IS NOT A PERMISSION THIS CLIENT GRANTS. The chain enforces its own:
 * `moderate_listing` and `set_listing_fee` call `require_office`, so a caller
 * without it is refused by the node whatever a client believes. This is for
 * deciding what to OFFER -- a button shown to somebody the node will refuse is
 * a refusal they cannot act on.
 *
 * Treating a `true` from here as authority would reimplement the check in the
 * one place that cannot enforce it.
 */
export interface Office {
  /** The role's own id. Stable; what `require_office` compares against. */
  roleId: bigint;
  /** The group the office belongs to. */
  groupId: bigint;
  /** The canonical lowercase slug -- `listing-moderator`, `admin`. Match on this. */
  name: string;
  /** The operator-configured label -- "Listing Moderator". Show this. */
  title: string;
  /** When the term began. */
  startedAt: Date;
}

interface OfficeRow {
  role_id: unknown;
  group_id: unknown;
  name: unknown;
  title: unknown;
  started_at: unknown;
}

export class IdentityClient {
  constructor(private readonly client: BranchClient) {}

  /**
   * Claim a person for the signing key.
   *
   * Refused if the key is already registered, and refused permanently if it
   * has ever been revoked. A *pending* proposal on the address is deleted
   * rather than honoured: nobody proved control of it, and the signature on
   * this transaction is that proof. That is what stops someone reserving a
   * stranger's address to lock them out of registering it.
   */
  async register(displayName: string): Promise<string> {
    return await this.client.write('register', { $display_name: displayName });
  }

  async setDisplayName(displayName: string): Promise<string> {
    return await this.client.write('set_display_name', { $display_name: displayName });
  }

  /** The caller's own record, or null if this key belongs to nobody. */
  async whoami(): Promise<Person | null> {
    const rows = await this.client.read<WhoamiRow>('whoami');
    const row = rows[0];
    if (!row) return null;
    return {
      personId: toBigInt(row.person_id, 'person_id'),
      handle: asString(row.handle, 'handle'),
      displayName: asString(row.display_name, 'display_name'),
      holderId: toBigInt(row.holder_id, 'holder_id'),
    };
  }

  /**
   * Propose an additional key.
   *
   * The proposal does nothing until the *new* key confirms it, which is the
   * point: proposing costs nothing and proves nothing, and only a signature
   * from the proposed key demonstrates control of it.
   *
   * `authType` is inferred from the address shape when omitted, using the same
   * dispatch `person_keys_address_shape` performs.
   */
  async proposeKey(
    address: string,
    label: string | null = null,
    authType?: AuthType
  ): Promise<string> {
    const canonical = canonicalAddress(address);
    return await this.client.write('propose_key', {
      $address: canonical,
      $auth_type: authType ?? authTypeOf(canonical),
      $label: label,
    });
  }

  /**
   * Confirm the proposal made for the signing key.
   *
   * Signed by the *proposed* key, not the one that proposed it.
   */
  async confirmKey(): Promise<string> {
    return await this.client.write('confirm_key');
  }

  /** Withdraw a proposal that has not been confirmed. */
  async cancelProposedKey(address: string): Promise<string> {
    return await this.client.write('cancel_proposed_key', {
      $address: canonicalAddress(address),
    });
  }

  /**
   * Revoke a key. **This cannot be undone.**
   *
   * Not "cannot be undone through this SDK" -- there is no action that
   * re-enables a revoked key, and the schema is built so there could not be
   * one. `person_keys` is append-only history: a row records that an address
   * belonged to a person for a period, and rewriting that would silently
   * re-attribute everything the key ever signed. The address is also globally
   * unique and permanent, so a revoked address can never be registered again
   * by anyone, including its owner.
   *
   * The chain refuses to revoke the caller's only active key -- add and
   * confirm a replacement first, or the account is lost for good.
   */
  async revokeKey(address: string): Promise<string> {
    return await this.client.write('revoke_key', {
      $address: canonicalAddress(address),
    });
  }

  /**
   * Every office the caller currently holds.
   *
   * Through the action rather than a SELECT, and that is not a style choice.
   * `SELECT` is granted, so this join is expressible client-side -- but
   * `holds_office` tests `started_at <= @block_timestamp`, and a query has no
   * block context. A client could only compare against its own clock, which is
   * benign for the seeded offices and wrong for a future-dated appointment:
   * precisely the case somebody scheduled on purpose. The action carries the
   * chain's own predicate.
   *
   * Ended terms are omitted: `group_appointments` is a history, so "held once"
   * and "holds now" are different questions and authority turns on the second.
   */
  async myOffices(): Promise<Office[]> {
    const rows = await this.client.read<OfficeRow>('my_offices');
    return rows.map((row) => ({
      roleId: toBigInt(row.role_id, 'role_id'),
      groupId: toBigInt(row.group_id, 'group_id'),
      name: asString(row.name, 'name'),
      title: asString(row.title, 'title'),
      startedAt: new Date(Number(toBigInt(row.started_at, 'started_at')) * 1000),
    }));
  }

  /**
   * Whether the caller holds a named office, by slug.
   *
   * Offered so every caller does not re-implement the same `.some()` over a
   * slug, and spell it differently. `listing-moderator` and `admin` are
   * different offices governing different actions -- taking an advertisement
   * down and changing what advertisements cost are separate authorities -- so
   * asking for "an office" is never the right question.
   */
  async holdsOffice(name: string): Promise<boolean> {
    return (await this.myOffices()).some((office) => office.name === name);
  }

  /** Every key on the caller's account, oldest first, with its standing. */
  async myKeys(): Promise<KeyRecord[]> {
    const rows = await this.client.read<KeyRow>('my_keys');
    return rows.map((row) => ({
      // Narrowed rather than coerced. These arrive as `unknown` from the node,
      // and String() on an unexpected object yields '[object Object]', which
      // would then be normalised or parsed as though it meant something.
      address: canonicalAddress(asString(row.address, 'address')),
      authType: asString(row.auth_type, 'auth_type') as AuthType,
      label: typeof row.label === 'string' ? row.label : null,
      status: toStatus(row.status),
      addedAt: new Date(Number(toBigInt(row.added_at, 'added_at')) * 1000),
    }));
  }
}
