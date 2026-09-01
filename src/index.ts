/**
 * @badger-cash/branch-sdk-js
 *
 * The package's single public entry point. Everything a caller may use is
 * re-exported here; nothing is deep-importable, because `exports` in
 * package.json declares only ".".
 *
 * The clients land on top of this: identity (#5), credits (#6), listings and
 * read paths (#7).
 */

export { signerFromPrivyWallet } from './signer.js';
export type { KwilEthSigner, PrivyEthereumWallet } from './signer.js';

export { authTypeOf, canonicalAddress, isCanonicalAddress } from './address.js';
export type { AuthType, CanonicalAddress } from './address.js';
