import { describe, expect, it } from 'vitest';

import { authTypeOf, canonicalAddress, isCanonicalAddress } from './address.js';

import type { CanonicalAddress } from './address.js';

// Hardhat account #0, as a provider hands it over: EIP-55 checksummed.
const CHECKSUMMED = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const LOWERCASE = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

const SECP256K1 = '02' + 'ab'.repeat(32); // 66 chars, a compressed public key
const ED25519 = 'cd'.repeat(32); // 64 chars

describe('canonicalAddress', () => {
  it('folds a checksummed EVM address to what person_keys stores', () => {
    expect(canonicalAddress(CHECKSUMMED)).toBe(LOWERCASE);
  });

  it('leaves an already-lowercase EVM address alone', () => {
    expect(canonicalAddress(LOWERCASE)).toBe(LOWERCASE);
  });

  it('gives both forms the same answer', () => {
    // The entire point of Rule 2. @caller arrives checksummed, the column is
    // lowercase, and a bare comparison of the two matches nothing -- so the
    // caller resolves to no person rather than to the wrong one, and every EVM
    // user looks like an unknown signer.
    expect(canonicalAddress(CHECKSUMMED)).toBe(canonicalAddress(LOWERCASE));
  });

  it('rejects a checksum that does not verify', () => {
    // Not pedantry. Lowercasing a mistyped address would produce a
    // well-formed address for an account nobody holds, and the listing or
    // credit would go somewhere unrecoverable. EIP-55 exists to catch this,
    // so a mixed-case address gets checked rather than merely folded.
    const mistyped = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    expect(() => canonicalAddress(mistyped)).toThrow();
  });

  it('normalises a secp256k1 public key', () => {
    expect(canonicalAddress(SECP256K1.toUpperCase())).toBe(SECP256K1);
  });

  it('normalises an ed25519 key', () => {
    expect(canonicalAddress(ED25519.toUpperCase())).toBe(ED25519);
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalAddress(`  ${CHECKSUMMED}\n`)).toBe(LOWERCASE);
  });

  describe('shapes the database would accept but should not', () => {
    it('rejects a right-length value that is not hexadecimal', () => {
      // person_keys_address_shape constrains length and nothing else, so 66
      // arbitrary lowercase characters satisfy its secp256k1 arm. The SDK
      // will not be the thing that puts one there. See badger-cash/branch#26.
      expect(() => canonicalAddress('z'.repeat(66))).toThrow(/hexadecimal/);
      expect(() => canonicalAddress('z'.repeat(64))).toThrow(/hexadecimal/);
    });

    it('rejects a 0x-prefixed value of secp256k1 length', () => {
      // '0x' plus 64 hex characters is 66 characters, which satisfies the
      // secp256k1 arm of the same constraint -- storing an EVM-looking value
      // under the wrong auth_type. Checking the prefix before the length
      // closes it here.
      const ambiguous = '0x' + 'ab'.repeat(32);
      expect(ambiguous).toHaveLength(66);
      expect(() => canonicalAddress(ambiguous)).toThrow(/42 characters/);
    });
  });

  describe('rejects what has no shape at all', () => {
    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
      ['too short', '0xabc'],
      ['65 characters', 'a'.repeat(65)],
      ['a bare word', 'vinarmani'],
    ])('%s', (_label, value) => {
      expect(() => canonicalAddress(value)).toThrow();
    });

    it('rejects a non-string', () => {
      expect(() => canonicalAddress(undefined as unknown as string)).toThrow(/must be a string/);
    });
  });
});

describe('authTypeOf', () => {
  it.each([
    [CHECKSUMMED, 'secp256k1_ep'],
    [LOWERCASE, 'secp256k1_ep'],
    [SECP256K1, 'secp256k1'],
    [ED25519, 'ed25519'],
  ])('classifies %s as %s', (address, expected) => {
    // The same dispatch person_keys_address_shape performs, so anything the
    // SDK accepts is something that constraint accepts too.
    expect(authTypeOf(address)).toBe(expected);
  });
});

describe('isCanonicalAddress', () => {
  it('is true only for the stored form', () => {
    expect(isCanonicalAddress(LOWERCASE)).toBe(true);
    expect(isCanonicalAddress(CHECKSUMMED)).toBe(false);
    expect(isCanonicalAddress('nonsense')).toBe(false);
  });
});

describe('the brand', () => {
  it('is what makes the rule unforgettable rather than documented', () => {
    // A stand-in for every lookup the clients will add in #5-#7.
    const lookup = (address: CanonicalAddress): string => address;

    // @ts-expect-error a raw string must not satisfy CanonicalAddress
    lookup(LOWERCASE);

    // Only a value that went through the boundary is accepted. If the brand
    // ever stopped working, the @ts-expect-error above becomes an unused
    // directive and `npm run typecheck` fails -- so this guarantee is checked
    // by the build, not by review.
    expect(lookup(canonicalAddress(CHECKSUMMED))).toBe(LOWERCASE);
  });
});
