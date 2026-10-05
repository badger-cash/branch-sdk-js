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

export {
  boolArray,
  BranchClient,
  fetchChainId,
  intArray,
  NAMESPACE,
  numeric,
  numericArray,
  textArray,
} from './client.js';
export type { ActionInputs, ActionTypes, ConnectOptions, DataInfo, KwilLike } from './client.js';

export { CreditsClient } from './credits.js';
export type { CreditEntry, CreditEntryKind, HistoryOptions } from './credits.js';

export { formatAmount, parseAmount, toAmount } from './amount.js';
export type { CreditAmount, FormatOptions } from './amount.js';

export { LISTING_SCALE, LISTING_TYPE_SLUG, ListingsClient } from './listings.js';
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

export { TypesClient } from './tokenTypes.js';
export type {
  DeclaredField,
  FieldDatatype,
  FieldUniqueScope,
  TypeSchema,
  TypeVersion,
} from './tokenTypes.js';

export { TokensClient } from './tokens.js';
export type {
  BooleanFacet,
  MintInput,
  RangeFacet,
  TextFacet,
  TokenCursor,
  TokenField,
  TokenHit,
  TokenRecord,
  TokenSearchOptions,
} from './tokens.js';

export { IdentityClient } from './identity.js';
export type { KeyRecord, KeyStatus, Office, Person } from './identity.js';

export { ActionFailedError, BranchError, UnconfirmedTransactionError } from './errors.js';
