import { KwilSigner, NodeKwil, Utils, WebKwil } from '@trufnetwork/kwil-js';

import type { Types } from '@trufnetwork/kwil-js';

import { canonicalAddress } from './address.js';
import {
  ActionFailedError,
  BranchError,
  UnconfirmedTransactionError,
  parseNodeFailure,
} from './errors.js';
import { CreditsClient } from './credits.js';
import { CurrenciesClient } from './currencies.js';
import { HoldingsClient } from './holdings.js';
import { CustodiansClient } from './custodians.js';
import { IdentityClient } from './identity.js';
import { TokensClient } from './tokens.js';
import { TypesClient } from './tokenTypes.js';

import type { CanonicalAddress } from './address.js';
import type { KwilEthSigner } from './signer.js';

/** Branch deploys its actions into kwil's default namespace. */
export const NAMESPACE = 'main';

/**
 * The part of kwil-js the clients use.
 *
 * Declared structurally so tests can substitute a double without a node.
 * `NodeKwil` and `WebKwil` both satisfy it.
 */
export type ActionInputs = Types.NamedParams;

/**
 * Declared parameter types, by parameter name.
 *
 * kwil infers a type from the JavaScript value, and the inference has no way
 * to reach NUMERIC: a string infers as `text` and a number as `int8`, so an
 * action expecting `numeric(78,0)` refuses both. The type has to be stated.
 */
// Derived from the constructor's own return type. kwil does not re-export
// NamedTypes or DataInfo from its public namespace, and deep-importing past
// the package's `exports` map would break the moment they reorganise.
export type DataInfo = ReturnType<typeof Utils.DataType.Numeric>;
export type ActionTypes = Record<string, DataInfo>;

/**
 * Declare a NUMERIC parameter, e.g. `numeric(78, 0)` for a ledger amount.
 *
 * Re-exported so callers never import kwil-js to send a number -- the whole
 * point of this package is that they should not have to.
 */
export function numeric(precision: number, scale: number): DataInfo {
  return Utils.DataType.Numeric(precision, scale);
}

/**
 * The array types, for an action that takes parallel key/value arrays.
 *
 * AN EMPTY ARRAY INFERS AS `null[]`, WHICH IS THE TRAP THESE EXIST FOR.
 * kwil-js resolves an array's element type from `value[0]`
 * (`utils/parameterEncoding.js`), so `[]` reads `undefined` and falls into the
 * `VarType.NULL` case -- the array is sent as an array of nothing with no
 * element type, and the engine refuses it against a declared `BOOL[]` or
 * `INT8[]`. A non-empty array of booleans or integers does infer correctly,
 * which is what makes this invisible until the one mint that omits a group.
 *
 * `mint_token` takes six key/value pairs and a caller normally fills two or
 * three, so the empty case is the common case rather than the edge. Declaring
 * all twelve costs nothing and removes the question.
 *
 * NUMERIC arrays cannot infer at all, empty or not, for the same reason a
 * scalar NUMERIC cannot: there is no JavaScript value that resolves to it.
 */
/**
 * A scalar INT8, for a parameter that may be NULL.
 *
 * A NON-NULL NUMBER INFERS FINE AND A NULL ONE DOES NOT, which is the whole
 * reason this exists. kwil-js resolves a parameter's type from its value, and
 * `null` falls into the `VarType.NULL` case -- so an optional INT8 like
 * `create_token_type`'s `$governing_role_id` is sent as a typeless null and the
 * engine refuses it against a declared INT8.
 *
 * `branch/scripts/seed-cars.sh` writes `int8:null` for exactly these, because
 * the CLI has the same problem and the same answer.
 */
export const intType: DataInfo = Utils.DataType.Int;

export const textArray: DataInfo = Utils.DataType.TextArray;
export const boolArray: DataInfo = Utils.DataType.BooleanArray;
export const intArray: DataInfo = Utils.DataType.IntArray;

/** Declare a `NUMERIC(p, s)[]` parameter. See `textArray` for why. */
export function numericArray(precision: number, scale: number): DataInfo {
  return Utils.DataType.NumericArray(precision, scale);
}

export interface KwilLike {
  execute(
    body: {
      namespace: string;
      name: string;
      inputs: ActionInputs[];
      types?: ActionTypes;
    },
    signer: KwilSigner,
    synchronous?: boolean
  ): Promise<{ data?: { tx_hash?: string } }>;
  // Note the asymmetry: execute takes an array of parameter sets, call takes
  // a single one. It is kwil's API, not a transcription error.
  call(
    body: { namespace: string; name: string; inputs: ActionInputs; types?: ActionTypes },
    signer?: KwilSigner
  ): Promise<{ data?: { result?: unknown } }>;
  // Read paths are plain SELECTs: decision 2b leaves SELECT granted, so browse
  // and search need no server-side code and no action per query.
  selectQuery<T extends object>(
    query: string,
    params?: Record<string, unknown>
  ): Promise<{ data?: T[] }>;
}

/** What a read-only client needs, which is a node and nothing else. */
export interface ReadOnlyOptions {
  /** The node's RPC endpoint, e.g. `http://127.0.0.1:8484`. */
  provider: string;
  /** Read from the node when omitted. */
  chainId?: string;
  /** Substitute a kwil client. Tests use this; callers should not need to. */
  kwil?: KwilLike;
}

export interface ConnectOptions {
  /** The node's RPC endpoint, e.g. `http://127.0.0.1:8484`. */
  provider: string;
  /** From `signerFromPrivyWallet`. */
  signer: KwilEthSigner;
  /** The signer's address, in any case. Normalised on the way in. */
  address: string;
  /** Read from the node when omitted, which is one fewer thing to get wrong. */
  chainId?: string;
  /** Substitute a kwil client. Tests use this; callers should not need to. */
  kwil?: KwilLike;
}

/**
 * Ask the node which chain it is.
 *
 * kwil speaks JSON-RPC at /rpc/v1 and has no REST API, so a GET to something
 * like /api/v1/chain_info returns 404 -- which reads as the wrong node rather
 * than the wrong protocol.
 */
export async function fetchChainId(provider: string): Promise<string> {
  const res = await fetch(`${provider}/rpc/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'user.chain_info', params: {} }),
  });
  if (!res.ok) {
    throw new BranchError(`${provider} answered ${String(res.status)} for chain_info`);
  }
  const body = (await res.json()) as { result?: { chain_id?: string } };
  const chainId = body.result?.chain_id;
  if (!chainId) {
    throw new BranchError(`${provider} returned no chain_id; is it a Branch node?`);
  }
  return chainId;
}

/**
 * A connection to a Branch node, signing as one person.
 *
 * `connect` rather than `new` because the chain id is read from the node when
 * it is not supplied, and a constructor cannot await.
 */
export class BranchClient {
  readonly identity: IdentityClient;
  readonly credits: CreditsClient;
  readonly currencies: CurrenciesClient;
  readonly holdings: HoldingsClient;
  /**
   * Resolving a custodian to an address. Unsigned, because a signed-out
   * browser has to render records and their photographs.
   */
  readonly custodians: CustodiansClient;
  /**
   * Tokens of any type, addressed by slug.
   *
   * THE ONLY RECORD SURFACE THIS PACKAGE HAS. There was a `listings` client
   * beside it, shaped like the automobile directory; it was deleted in 0.7.0 once
   * its car vocabulary moved to the application that is actually about cars
   * (badger-cash/island-nook-directory-45#197).
   */
  readonly tokens: TokensClient;
  /**
   * What a type declares, so a consumer can ASK rather than compile it in.
   *
   * The keystone of #46: without it, every consumer re-hardcodes the field names
   * this package stopped hardcoding.
   */
  readonly types: TypesClient;

  private constructor(
    private readonly kwil: KwilLike,
    /**
     * Absent on a read-only client. Plain SELECTs need no signature, and view
     * actions do -- so this being null is what distinguishes the two, and
     * `read` says so rather than failing somewhere inside kwil.
     */
    private readonly kwilSigner: KwilSigner | null,
    /** The caller's own address, or null when nobody is signing. */
    readonly address: CanonicalAddress | null
  ) {
    this.identity = new IdentityClient(this);
    this.credits = new CreditsClient(this);
    this.currencies = new CurrenciesClient(this);
    this.holdings = new HoldingsClient(this);
    this.custodians = new CustodiansClient(this);
    this.tokens = new TokensClient(this);
    this.types = new TypesClient(this);
  }

  static async connect(options: ConnectOptions): Promise<BranchClient> {
    const address = canonicalAddress(options.address);
    const chainId = options.chainId ?? (await fetchChainId(options.provider));

    // WebKwil authenticates through cookies and NodeKwil through the key, so
    // the choice follows the runtime rather than a caller's preference.
    const kwil =
      options.kwil ??
      (typeof globalThis.window === 'undefined'
        ? new NodeKwil({ kwilProvider: options.provider, chainId })
        : new WebKwil({ kwilProvider: options.provider, chainId }));

    // The identifier goes in canonical form. @caller is derived from the
    // signature rather than from this, but keeping the two consistent means a
    // caller never sees one case here and another on chain.
    return new BranchClient(kwil, new KwilSigner(options.signer, address), address);
  }

  /**
   * A client for the public read surface, with nobody signing.
   *
   * Browse and search are plain SELECTs against the node -- Decision 2b leaves
   * `SELECT` granted, which is the whole reason "the entire browse and search
   * surface needs no server-side code". None of it touches a signer, and
   * requiring one meant an anonymous visitor could not look at a classified ad
   * without first creating an account, which is exactly backwards for a
   * marketplace.
   *
   * `write` and `read` reject on this client. `query` is the whole of it.
   */
  static async connectReadOnly(options: ReadOnlyOptions): Promise<BranchClient> {
    const chainId = options.chainId ?? (await fetchChainId(options.provider));
    const kwil =
      options.kwil ??
      (typeof globalThis.window === 'undefined'
        ? new NodeKwil({ kwilProvider: options.provider, chainId })
        : new WebKwil({ kwilProvider: options.provider, chainId }));

    return new BranchClient(kwil, null, null);
  }

  /** Whether this client can sign. False for `connectReadOnly`. */
  get canSign(): boolean {
    return this.kwilSigner !== null;
  }

  /**
   * Send a transaction and turn a refusal into something a caller can use.
   *
   * `execute(..., true)` broadcasts with COMMIT, so kwil waits for the block
   * and compares the committed result code against zero itself -- a failed
   * action rejects rather than resolving. What it rejects with is a bare Error
   * carrying the JSON envelope as its message, which is indistinguishable from
   * a transport failure without parsing it.
   *
   * So the envelope is parsed here and rethrown as ActionFailedError. Anything
   * that is not that envelope propagates untouched, because a node that is
   * unreachable and an action that was refused call for different responses.
   */
  async write(action: string, inputs: ActionInputs = {}, types?: ActionTypes): Promise<string> {
    if (this.kwilSigner === null) {
      throw new BranchError(
        `${action} is a transaction and needs a signer. This client came from ` +
          'connectReadOnly, which exists for the public read surface only.'
      );
    }

    let res;
    try {
      res = await this.kwil.execute(
        types === undefined
          ? { namespace: NAMESPACE, name: action, inputs: [inputs] }
          : { namespace: NAMESPACE, name: action, inputs: [inputs], types },
        this.kwilSigner,
        true
      );
    } catch (err) {
      const failure = parseNodeFailure(err);
      if (failure) {
        throw new ActionFailedError(action, failure.code, failure.log, failure.txHash);
      }
      throw err;
    }

    const txHash = res.data?.tx_hash;
    if (!txHash) {
      throw new UnconfirmedTransactionError(action, 'the node returned no transaction hash');
    }
    return txHash;
  }

  /**
   * Run a plain SELECT against the node.
   *
   * Unauthenticated by design: on-chain data is public and decision 2b leaves
   * SELECT granted, which is what lets the whole browse and search surface
   * exist without server-side code. Anything that must resolve `@caller` needs
   * an action instead, because a query cannot prove who is asking.
   */
  async query<T extends object>(sql: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const res = await this.kwil.selectQuery<T>(sql, params);
    return res.data ?? [];
  }

  /**
   * Call a view action WITHOUT a signer.
   *
   * badger-cash/branch#119. The browse and search surface must answer a visitor
   * who has never connected a wallet, so the actions behind it -- `search_tokens`,
   * `token_fields`, `get_token`, `type_fee_tiers`, `token_type_schema` -- do not
   * touch `@caller` and, as 24-tokens.sql puts it, MAY NEVER START. The moment one
   * does, it becomes a signed call and the front page asks a stranger to approve a
   * signature to look at cars.
   *
   * WHY THIS EXISTS AT ALL, rather than the raw SELECTs it replaces. Decision 2b
   * leaves SELECT granted, so the old read path was plain SQL and needed no server
   * side. That worked until the schema moved underneath it: #69 renamed the
   * registry and #118 made field declarations type-scoped, and both emptied the
   * grid with an error INSIDE an HTTP 200. A table name is not an interface; an
   * action is.
   */
  async readPublic<T>(
    action: string,
    inputs: ActionInputs = {},
    types?: ActionTypes
  ): Promise<T[]> {
    // Spread rather than `types: types`, because exactOptionalPropertyTypes is on:
    // an explicit `undefined` is not the same as an absent property, and passing
    // one would be a type error at the call rather than a missing declaration at
    // the node.
    const res = await this.kwil.call({
      namespace: NAMESPACE,
      name: action,
      inputs,
      ...(types === undefined ? {} : { types }),
    });
    const result = res.data?.result;
    return Array.isArray(result) ? (result as T[]) : [];
  }

  /** Call a view action. Signed, because most of them read `@caller`. */
  async read<T>(action: string, inputs: ActionInputs = {}): Promise<T[]> {
    if (this.kwilSigner === null) {
      throw new BranchError(
        `${action} is a view action and needs a signer -- most of them read @caller. ` +
          'This client came from connectReadOnly; use connect to call one.'
      );
    }
    const res = await this.kwil.call(
      { namespace: NAMESPACE, name: action, inputs },
      this.kwilSigner
    );
    const result = res.data?.result;
    return Array.isArray(result) ? (result as T[]) : [];
  }
}
