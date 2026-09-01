import { beforeAll, describe, expect, it } from 'vitest';

import { ActionFailedError, BranchClient, fetchChainId } from '../../src/index.js';

import { localWallet } from './local-wallet.js';

/**
 * The identity client against a live node.
 *
 * The unit tests drive a kwil double, so they can prove the client reacts
 * correctly to a failure code but not that a real refusal produces one. These
 * assertions are the other half: the action layer refuses something, and the
 * refusal has to arrive as an exception rather than as a transaction hash that
 * quietly means nothing.
 */

const PROVIDER = process.env.BRANCH_PROVIDER ?? 'http://127.0.0.1:8484';
const EXPLICIT = process.env.BRANCH_PROVIDER !== undefined;

let chainId = '';
let reachable = false;
let reason = '';

beforeAll(async () => {
  try {
    chainId = await fetchChainId(PROVIDER);
    reachable = true;
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
});

function requireNode(): boolean {
  if (reachable) return true;
  if (EXPLICIT) {
    throw new Error(`BRANCH_PROVIDER is set to ${PROVIDER} but no node answered: ${reason}`);
  }
  console.warn(`no Branch node at ${PROVIDER} -- skipping`);
  return false;
}

async function connect(): Promise<BranchClient> {
  const { address, signer } = await localWallet();
  return await BranchClient.connect({ provider: PROVIDER, chainId, address, signer });
}

describe('identity client', () => {
  it('registers, then reads its own record back', async () => {
    if (!requireNode()) return;
    const client = await connect();

    await expect(client.identity.whoami()).resolves.toBeNull();

    await client.identity.register('Integration Alice');

    const me = await client.identity.whoami();
    expect(me?.displayName).toBe('Integration Alice');
    // The handle is derived from the address by the action layer.
    expect(me?.handle).toMatch(/^u-/);
    expect(me?.personId).toBeGreaterThan(0n);
  }, 60_000);

  it('changes a display name', async () => {
    if (!requireNode()) return;
    const client = await connect();
    await client.identity.register('Before');

    await client.identity.setDisplayName('After');

    await expect(client.identity.whoami()).resolves.toMatchObject({ displayName: 'After' });
  }, 60_000);

  /**
   * The assertion the unit tests cannot make.
   *
   * `register` on an already-registered key is refused by the action layer.
   * The transaction is still mined, so without reading the result code back
   * this resolves with a hash and looks like success.
   */
  it('surfaces a real refusal as an error, not a transaction hash', async () => {
    if (!requireNode()) return;
    const client = await connect();
    await client.identity.register('Once');

    await expect(client.identity.register('Twice')).rejects.toThrow(ActionFailedError);
    await expect(client.identity.register('Twice')).rejects.toThrow(/already registered/);
  }, 60_000);

  it('lists the caller keys with their standing', async () => {
    if (!requireNode()) return;
    const client = await connect();
    await client.identity.register('Key Lister');

    const keys = await client.identity.myKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ status: 'active', authType: 'secp256k1_ep' });
    expect(keys[0]?.address).toBe(client.address);
    expect(keys[0]?.addedAt.getTime()).toBeGreaterThan(0);
  }, 60_000);

  it('carries a key through proposal, confirmation and revocation', async () => {
    if (!requireNode()) return;

    const first = await connect();
    await first.identity.register('Key Holder');

    const { address: secondAddress, signer: secondSigner } = await localWallet();

    await first.identity.proposeKey(secondAddress, 'second device');

    const afterProposal = await first.identity.myKeys();
    expect(afterProposal.map((k) => k.status).sort()).toEqual(['active', 'pending']);

    // A proposal is inert until the proposed key itself confirms. Signing this
    // with the proposing key would prove nothing about control of the new one.
    const second = await BranchClient.connect({
      provider: PROVIDER,
      chainId,
      address: secondAddress,
      signer: secondSigner,
    });
    await second.identity.confirmKey();

    const afterConfirm = await second.identity.myKeys();
    expect(afterConfirm.filter((k) => k.status === 'active')).toHaveLength(2);
    // Both keys resolve to the same person.
    expect((await second.identity.whoami())?.personId).toBe(
      (await first.identity.whoami())?.personId
    );

    await second.identity.revokeKey(first.address);

    const afterRevoke = await second.identity.myKeys();
    const revoked = afterRevoke.find((k) => k.address === first.address);
    expect(revoked?.status).toBe('revoked');

    // Revocation is final in both directions: the old key can no longer act,
    // and its address can never be registered again by anyone.
    await expect(first.identity.setDisplayName('Should Fail')).rejects.toThrow(ActionFailedError);
  }, 120_000);

  it('refuses to revoke the only key, rather than locking the account out', async () => {
    if (!requireNode()) return;
    const client = await connect();
    await client.identity.register('Sole Key');

    await expect(client.identity.revokeKey(client.address)).rejects.toThrow(/only key/);
  }, 60_000);
});
