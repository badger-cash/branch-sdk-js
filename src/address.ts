import { getAddress } from 'ethers';

/**
 * The three authenticators `person_keys.auth_type` accepts.
 *
 * Mirrors `person_keys_auth_vocab` in branch's 01-people.sql.
 */
export type AuthType = 'secp256k1_ep' | 'secp256k1' | 'ed25519';

declare const canonical: unique symbol;

/**
 * An address known to be in the form `person_keys.address` stores.
 *
 * The brand is the point. Every SDK function that compares an address takes
 * this type, and the only way to obtain one is `canonicalAddress()`. A raw
 * `string` will not type-check, so a caller cannot construct a query that
 * compares an un-normalised address -- which is the whole requirement, moved
 * from something to remember into something the compiler refuses.
 */
export type CanonicalAddress = string & { readonly [canonical]: true };

/**
 * Rule 2, at the boundary.
 *
 * `@caller` for an EVM signer is EIP-55 checksummed and therefore mixed case,
 * while `person_keys.address` stores canonical lowercase. branch's schema
 * README calls a bare `address = @caller` "the single easiest thing to get
 * wrong in the action layer", and it fails open in the worst way: the lookup
 * returns no rows, so the caller resolves to no person rather than to the
 * wrong one. Every EVM user then looks like an unknown signer.
 *
 * Lowercasing is only half of it. The shape is validated too, because the
 * database's own check does not validate the alphabet -- see the note on
 * `assertHex` below.
 */
export function canonicalAddress(input: string): CanonicalAddress {
  if (typeof input !== 'string') {
    throw new TypeError(`address must be a string, received ${typeof input}`);
  }

  const trimmed = input.trim();
  if (trimmed === '') throw new TypeError('address must not be empty');

  // The 0x prefix decides which authenticator this is, and is checked before
  // length. Going the other way -- length first -- would let `0x` followed by
  // 64 hex characters be read as a 66-character secp256k1 public key.
  if (trimmed.slice(0, 2).toLowerCase() === '0x') {
    if (trimmed.length !== 42) {
      throw new TypeError(
        `a 0x-prefixed address is an EVM address and must be 42 characters, received ${String(trimmed.length)}`
      );
    }
    // getAddress validates the EIP-55 checksum on a mixed-case address and
    // accepts an all-lowercase one, which is exactly the behaviour wanted: a
    // checksummed address with a typo in it is rejected rather than lowercased
    // into a valid-looking address for an account nobody holds.
    return getAddress(trimmed).toLowerCase() as CanonicalAddress;
  }

  const lowered = trimmed.toLowerCase();

  if (lowered.length === 66) {
    assertHex(lowered, 'secp256k1');
    return lowered as CanonicalAddress;
  }
  if (lowered.length === 64) {
    assertHex(lowered, 'ed25519');
    return lowered as CanonicalAddress;
  }

  throw new TypeError(
    `address has no recognised shape (${String(trimmed.length)} characters). Expected ` +
      '42 with a 0x prefix for secp256k1_ep, 66 for secp256k1, or 64 for ed25519'
  );
}

/**
 * Which authenticator produced an address, inferred from its shape.
 *
 * The same dispatch `person_keys_address_shape` performs, so an address the
 * SDK accepts is one that constraint will also accept.
 */
export function authTypeOf(address: string): AuthType {
  const canonical = canonicalAddress(address);
  if (canonical.startsWith('0x')) return 'secp256k1_ep';
  return canonical.length === 66 ? 'secp256k1' : 'ed25519';
}

/** Narrows a string that has already been through `canonicalAddress`. */
export function isCanonicalAddress(value: string): value is CanonicalAddress {
  try {
    return canonicalAddress(value) === value;
  } catch {
    return false;
  }
}

/**
 * The database does not do this, and it is the reason the SDK must.
 *
 * `person_keys_address_shape` constrains length and, for EVM, the 0x prefix.
 * It says nothing about the alphabet, so 66 arbitrary lowercase characters
 * satisfy the `secp256k1` arm. Tracked as badger-cash/branch#26.
 */
function assertHex(value: string, authType: AuthType): void {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57; // 0-9
    const isLowerAf = c >= 97 && c <= 102; // a-f
    if (!isDigit && !isLowerAf) {
      throw new TypeError(
        `a ${authType} address must be hexadecimal, found ${JSON.stringify(value[i])} at index ${String(i)}`
      );
    }
  }
}
