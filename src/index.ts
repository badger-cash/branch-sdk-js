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

export { CustodiansClient, objectUrl } from './custodians.js';
export type { CustodianEndpoint } from './custodians.js';

export { BranchClient, fetchChainId, NAMESPACE, numeric } from './client.js';
export type { ActionInputs, ActionTypes, ConnectOptions, DataInfo, KwilLike } from './client.js';

export { CreditsClient } from './credits.js';
export type { CreditEntry, CreditEntryKind, HistoryOptions } from './credits.js';

export { formatAmount, parseAmount, toAmount } from './amount.js';
export type { CreditAmount, FormatOptions } from './amount.js';

export { LISTING_SCALE, ListingsClient } from './listings.js';
export type {
  BrowseOptions,
  CreateListingInput,
  FeeTier,
  Listing,
  ListingOutcome,
  ListingSummary,
  OwnListing,
  PageCursor,
  SearchOptions,
} from './listings.js';

export { IdentityClient } from './identity.js';
export type { KeyRecord, KeyStatus, Person } from './identity.js';

export { ActionFailedError, BranchError, UnconfirmedTransactionError } from './errors.js';
