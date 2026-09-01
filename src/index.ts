/**
 * @badger-cash/branch-sdk-js
 *
 * The package's single public entry point. Everything a caller may use is
 * re-exported here; nothing is deep-importable, because `exports` in
 * package.json declares only ".".
 *
 * Credits (#6) and listings (#7) land on top of BranchClient.
 */

export { signerFromPrivyWallet } from './signer.js';
export type { KwilEthSigner, PrivyEthereumWallet } from './signer.js';

export { authTypeOf, canonicalAddress, isCanonicalAddress } from './address.js';
export type { AuthType, CanonicalAddress } from './address.js';

export { BranchClient, fetchChainId, NAMESPACE } from './client.js';
export type { ActionInputs, ConnectOptions, KwilLike } from './client.js';

export { IdentityClient } from './identity.js';
export type { KeyRecord, KeyStatus, Person } from './identity.js';

export { ActionFailedError, BranchError, UnconfirmedTransactionError } from './errors.js';
