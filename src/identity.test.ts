import { describe, expect, it } from 'vitest';

import { BranchClient } from './client.js';
import { ActionFailedError, UnconfirmedTransactionError } from './errors.js';

import type { ActionInputs, KwilLike } from './client.js';

const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const LOWER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const TX = '0xdeadbeef';

interface Recorded {
  kind: 'execute' | 'call';
  name: string;
  inputs: unknown;
}

/**
 * A kwil double, modelling how the real client actually reports failure.
 *
 * This originally returned a result code for the client to read back, which is
 * what I assumed kwil did. It is not: `broadcastClient` compares the committed
 * code itself and *throws*, with the JSON envelope as the message. The tests
 * passed against the wrong model until a live node contradicted it.
 */
function fakeKwil(opts: {
  failure?: { code: number; log: string };
  transportError?: Error;
  noTxHash?: boolean;
  callResult?: unknown;
}): { kwil: KwilLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const kwil: KwilLike = {
    execute(body): Promise<{ data?: { tx_hash?: string } }> {
      calls.push({ kind: 'execute', name: body.name, inputs: body.inputs });
      if (opts.transportError) return Promise.reject(opts.transportError);
      if (opts.failure) {
        return Promise.reject(
          new Error(
            JSON.stringify({
              tx_hash: TX,
              result: { code: opts.failure.code, gas: 0, log: opts.failure.log },
            })
          )
        );
      }
      if (opts.noTxHash) return Promise.resolve({ data: {} });
      return Promise.resolve({ data: { tx_hash: TX } });
    },
    call(body): Promise<{ data?: { result?: unknown } }> {
      calls.push({ kind: 'call', name: body.name, inputs: body.inputs });
      return Promise.resolve({ data: { result: opts.callResult ?? [] } });
    },
    selectQuery(): Promise<{ data?: never[] }> {
      return Promise.resolve({ data: [] });
    },
  };
  return { kwil, calls };
}

async function connect(opts: Parameters<typeof fakeKwil>[0] = {}): Promise<{
  client: BranchClient;
  calls: Recorded[];
}> {
  const { kwil, calls } = fakeKwil(opts);
  const client = await BranchClient.connect({
    provider: 'http://example.invalid',
    chainId: 'kwil-testnet',
    address: ADDRESS,
    signer: { signMessage: () => Promise.resolve('0x00') },
    kwil,
  });
  return { client, calls };
}

function inputsOf(calls: Recorded[], name: string): Record<string, unknown> {
  const rec = calls.find((c) => c.name === name);
  const inputs = rec?.inputs;
  return (Array.isArray(inputs) ? (inputs[0] as ActionInputs) : inputs) as Record<string, unknown>;
}

describe('writes report what actually happened', () => {
  /**
   * The behaviour that matters most in this client.
   *
   * The action layer refuses things carefully -- an already-registered key, a
   * revoked one, a duplicate VIN. Each refusal arrives from kwil as a bare
   * Error whose message is a JSON envelope, which a caller cannot act on and
   * cannot tell apart from the node being down.
   */
  it('turns a refusal into a typed error', async () => {
    const { client } = await connect({
      failure: { code: 65535, log: 'ERROR: this key is already registered' },
    });

    await expect(client.identity.register('Ada')).rejects.toThrow(ActionFailedError);
    await expect(client.identity.register('Ada')).rejects.toThrow(/already registered/);
  });

  it('carries the code, log and hash as fields rather than a string', async () => {
    const { client } = await connect({ failure: { code: 65535, log: 'ERROR: nope' } });

    await expect(client.identity.register('Ada')).rejects.toMatchObject({
      action: 'register',
      code: 65535,
      log: 'ERROR: nope',
      txHash: TX,
    });
  });

  /**
   * A node that is unreachable and an action that was refused call for
   * different responses -- one is worth retrying and the other never will be.
   * Relabelling every failure as an on-chain refusal would erase that.
   */
  it('lets a transport failure propagate as itself', async () => {
    const boom = new Error('fetch failed');
    const { client } = await connect({ transportError: boom });

    await expect(client.identity.register('Ada')).rejects.toThrow(boom);
    await expect(client.identity.register('Ada')).rejects.not.toThrow(ActionFailedError);
  });

  it('does not claim success without a transaction hash', async () => {
    const { client } = await connect({ noTxHash: true });
    await expect(client.identity.register('Ada')).rejects.toThrow(UnconfirmedTransactionError);
  });

  it('returns the transaction hash on success', async () => {
    const { client } = await connect();
    await expect(client.identity.register('Ada')).resolves.toBe(TX);
  });
});

describe('register and display name', () => {
  it('sends the display name', async () => {
    const { client, calls } = await connect();
    await client.identity.register('Ada Lovelace');
    expect(inputsOf(calls, 'register')).toEqual({ $display_name: 'Ada Lovelace' });
  });

  it('sets a display name', async () => {
    const { client, calls } = await connect();
    await client.identity.setDisplayName('Ada L.');
    expect(inputsOf(calls, 'set_display_name')).toEqual({ $display_name: 'Ada L.' });
  });
});

describe('whoami', () => {
  it('maps the row', async () => {
    const { client } = await connect({
      callResult: [{ person_id: 7, handle: 'u-abc', display_name: 'Ada', holder_id: 9 }],
    });
    await expect(client.identity.whoami()).resolves.toEqual({
      personId: 7n,
      handle: 'u-abc',
      displayName: 'Ada',
      holderId: 9n,
    });
  });

  it('reads ids as bigint, whether the node sends a number or a string', async () => {
    const { client } = await connect({
      callResult: [
        { person_id: '9007199254740993', handle: 'u-x', display_name: 'X', holder_id: 1 },
      ],
    });
    const me = await client.identity.whoami();
    // Past Number.MAX_SAFE_INTEGER, which a number would round.
    expect(me?.personId).toBe(9007199254740993n);
  });

  it('is null when the key belongs to nobody', async () => {
    const { client } = await connect({ callResult: [] });
    await expect(client.identity.whoami()).resolves.toBeNull();
  });
});

describe('key lifecycle', () => {
  it('normalises the address on the way in', async () => {
    const { client, calls } = await connect();
    await client.identity.proposeKey(ADDRESS, 'laptop');

    // Checksummed in, canonical out -- person_keys stores lowercase, and the
    // caller should never have to know that.
    expect(inputsOf(calls, 'propose_key')).toEqual({
      $address: LOWER,
      $auth_type: 'secp256k1_ep',
      $label: 'laptop',
    });
  });

  it('infers auth type from shape', async () => {
    const { client, calls } = await connect();
    await client.identity.proposeKey('cd'.repeat(32));
    expect(inputsOf(calls, 'propose_key')).toMatchObject({ $auth_type: 'ed25519' });
  });

  it('refuses an address the schema would refuse', async () => {
    const { client } = await connect();
    // Right length, wrong alphabet -- the shape branch#26 closed.
    await expect(client.identity.proposeKey('z'.repeat(66))).rejects.toThrow(/hexadecimal/);
  });

  it('normalises for revoke and cancel too', async () => {
    const { client, calls } = await connect();
    await client.identity.revokeKey(ADDRESS);
    await client.identity.cancelProposedKey(ADDRESS);
    expect(inputsOf(calls, 'revoke_key')).toEqual({ $address: LOWER });
    expect(inputsOf(calls, 'cancel_proposed_key')).toEqual({ $address: LOWER });
  });

  it('confirms with no arguments, because the signer is the proof', async () => {
    const { client, calls } = await connect();
    await client.identity.confirmKey();
    expect(inputsOf(calls, 'confirm_key')).toEqual({});
  });
});

describe('myKeys', () => {
  it('maps status, label and timestamp', async () => {
    const { client } = await connect({
      callResult: [
        {
          address: LOWER,
          auth_type: 'secp256k1_ep',
          label: 'laptop',
          status: 'active',
          added_at: 1788224916,
        },
        {
          address: 'cd'.repeat(32),
          auth_type: 'ed25519',
          label: null,
          status: 'revoked',
          added_at: 1788224900,
        },
      ],
    });

    const keys = await client.identity.myKeys();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({ address: LOWER, status: 'active', label: 'laptop' });
    expect(keys[0]?.addedAt.getTime()).toBe(1788224916 * 1000);
    expect(keys[1]).toMatchObject({ status: 'revoked', label: null });
  });

  it('rejects a status the schema could not have produced', async () => {
    const { client } = await connect({
      callResult: [
        { address: LOWER, auth_type: 'secp256k1_ep', label: null, status: 'weird', added_at: 1 },
      ],
    });
    await expect(client.identity.myKeys()).rejects.toThrow(/unrecognised key status/);
  });
});
