import { BranchError } from './errors.js';

import type { BranchClient } from './client.js';

/**
 * Where a custodian answers, as the chain currently records it.
 *
 * `updatedAt` is when the custodian last made this claim. It is NOT an expiry
 * and must not be treated as one: endpoints are published on change, not on a
 * schedule, so an old value means nothing has moved rather than that anybody is
 * gone. Whether the address answers is a question for the address.
 */
export interface CustodianEndpoint {
  url: string;
  updatedAt: bigint;
}

interface EndpointRow {
  url: unknown;
  updated_at: unknown;
}

const toEndpoint = (row: EndpointRow | undefined): CustodianEndpoint | null => {
  if (!row || typeof row.url !== 'string' || row.url === '') return null;
  // INT8 crosses as a checked number or a string depending on the path; both
  // are safe to widen, and a height that does not parse is a bug rather than a
  // missing endpoint, so it throws instead of resolving to null.
  const at = row.updated_at;
  if (typeof at !== 'number' && typeof at !== 'string' && typeof at !== 'bigint') {
    throw new BranchError(`custodian endpoint returned a non-numeric updated_at: ${String(at)}`);
  }
  return { url: row.url, updatedAt: BigInt(at) };
};

/**
 * Resolving a custodian to an address.
 *
 * THE CHAIN SAYS WHERE, AND NOTHING ELSE ABOUT IT. What a custodian holds, and
 * who it will serve, is the custodian's own business and is settled at request
 * time by whatever it decides from the request -- headers, authentication, a
 * signed challenge. Nothing here should grow a notion of capability.
 *
 * UNSIGNED, DELIBERATELY. These are plain SELECTs rather than view actions,
 * because a signed-out browser has to render listings and their photographs.
 * `client.read` would demand a signer; `client.query` does not. Nothing here
 * resolves `@caller`, so there is nothing a signature would prove.
 */
export class CustodiansClient {
  constructor(private readonly client: BranchClient) {}

  /**
   * Where the custodian holding a given metadata field currently answers.
   *
   * Takes the FIELD rather than a listing, because the custodian is a property
   * of the schema -- every listing's photographs are held by whoever holds
   * photographs -- so a client resolves this once and reuses it, rather than
   * once per row.
   *
   * Returns null when the field names no custodian, or when that custodian has
   * never announced or has withdrawn. All three mean "you cannot reach this",
   * and a caller has a field name to report either way.
   */
  async forField(entityType: string, identifier: string): Promise<CustodianEndpoint | null> {
    const rows = await this.client.query<EndpointRow>(
      `SELECT e.url, e.updated_at
         FROM metadata_schemas s
         JOIN custodian_endpoints e
           ON (e.group_id = s.custodian_group_id OR e.person_id = s.custodian_person_id)
        WHERE s.entity_type = $entity_type
          AND s.identifier = $identifier
          AND s.token_class_id IS NULL
          AND s.deleted_at IS NULL
          AND e.deleted_at IS NULL
        LIMIT 1`,
      { $entity_type: entityType, $identifier: identifier }
    );
    return toEndpoint(rows[0]);
  }

  /** Where a group custodian answers, by group id. */
  async forGroup(groupId: bigint | number): Promise<CustodianEndpoint | null> {
    const rows = await this.client.query<EndpointRow>(
      `SELECT url, updated_at FROM custodian_endpoints
        WHERE group_id = $group_id AND deleted_at IS NULL LIMIT 1`,
      { $group_id: Number(groupId) }
    );
    return toEndpoint(rows[0]);
  }

  /** Where a person custodian answers, by person id. */
  async forPerson(personId: bigint | number): Promise<CustodianEndpoint | null> {
    const rows = await this.client.query<EndpointRow>(
      `SELECT url, updated_at FROM custodian_endpoints
        WHERE person_id = $person_id AND deleted_at IS NULL LIMIT 1`,
      { $person_id: Number(personId) }
    );
    return toEndpoint(rows[0]);
  }

  /**
   * Where the photographs attached to listings are served from.
   *
   * A named convenience because it is the one every browse page needs, and
   * because 'token'/'photos' as bare strings at a call site invites a typo that
   * returns null and reads like "the custodian is down".
   */
  async forListingPhotos(): Promise<CustodianEndpoint | null> {
    return this.forField('token', 'photos');
  }
}

/**
 * Build a fetchable URL for an object the chain identifies.
 *
 * THE KEY IS OPAQUE. It is whatever the custodian issued -- today sixteen random
 * bytes in hex plus a file extension, deliberately unguessable rather than
 * derived from the bytes, because an object URL is public by construction and a
 * derived key would let anyone holding one enumerate the rest. Nothing here
 * parses it, and nothing should: the custodian owns its own naming, which is the
 * entire reason the chain stores an identifier instead of a URL.
 *
 * Tolerates a full URL as the key. Listings published before the change to
 * identifiers carry an absolute address, and those still have to render.
 */
export const objectUrl = (endpoint: CustodianEndpoint | string, key: string): string => {
  if (key.startsWith('http://') || key.startsWith('https://')) return key;
  const base = typeof endpoint === 'string' ? endpoint : endpoint.url;
  return `${base.replace(/\/+$/, '')}/objects/${key}`;
};
