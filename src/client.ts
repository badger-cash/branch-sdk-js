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
import { IdentityClient } from './identity.js';
import { ListingsClient } from './listings.js';

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
    body: { namespace: string; name: string; inputs: ActionInputs },
    signer?: KwilSigner
  ): Promise<{ data?: { result?: unknown } }>;
  // Read paths are plain SELECTs: decision 2b leaves SELECT granted, so browse
  // and search need no server-side code and no action per query.
  selectQuery<T extends object>(
    query: string,
    params?: Record<string, unknown>
  ): Promise<{ data?: T[] }>;
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
  readonly listings: ListingsClient;

  private constructor(
    private readonly kwil: KwilLike,
    private readonly kwilSigner: KwilSigner,
    /** The caller's own address, in the form `person_keys` stores. */
    readonly address: CanonicalAddress
  ) {
    this.identity = new IdentityClient(this);
    this.credits = new CreditsClient(this);
    this.listings = new ListingsClient(this);
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

  /** Call a view action. Signed, because most of them read `@caller`. */
  async read<T>(action: string, inputs: ActionInputs = {}): Promise<T[]> {
    const res = await this.kwil.call(
      { namespace: NAMESPACE, name: action, inputs },
      this.kwilSigner
    );
    const result = res.data?.result;
    return Array.isArray(result) ? (result as T[]) : [];
  }
}
