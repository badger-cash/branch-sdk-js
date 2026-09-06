import { describe, expect, it, vi } from 'vitest';

import { BranchClient } from './client.js';
import { BranchError } from './errors.js';

/**
 * A kwil double that records what it was asked and never needs a signer.
 * `selectQuery` is the only method a read-only client may reach.
 */
const fakeKwil = () => ({
  selectQuery: vi.fn().mockResolvedValue({ data: [{ id: '1' }] }),
  call: vi.fn(),
  execute: vi.fn(),
});

const options = (kwil: ReturnType<typeof fakeKwil>) => ({
  provider: 'http://node.invalid:8484',
  chainId: 'test-chain',
  kwil: kwil as never,
});

describe('connectReadOnly', () => {
  it('needs no signer and no address', async () => {
    // The reason this exists. Browse and search are plain SELECTs, so requiring
    // a signer meant an anonymous visitor could not look at a classified ad
    // without first creating an account.
    const kwil = fakeKwil();
    const client = await BranchClient.connectReadOnly(options(kwil));

    expect(client.address).toBeNull();
    expect(client.canSign).toBe(false);
  });

  it('runs plain queries', async () => {
    const kwil = fakeKwil();
    const client = await BranchClient.connectReadOnly(options(kwil));

    const rows = await client.query('SELECT 1');
    expect(rows).toEqual([{ id: '1' }]);
    expect(kwil.selectQuery).toHaveBeenCalledOnce();
  });

  it('serves the listings read surface, which is the point', async () => {
    // search resolves the listing class first, then the rows -- two queries,
    // both plain SELECTs, neither signed.
    const kwil = fakeKwil();
    kwil.selectQuery
      .mockResolvedValueOnce({ data: [{ class_id: '1', state_id: '1' }] })
      .mockResolvedValueOnce({ data: [] });
    const client = await BranchClient.connectReadOnly(options(kwil));

    await expect(client.listings.search({ make: 'Toyota' })).resolves.toEqual([]);
    expect(kwil.selectQuery).toHaveBeenCalledTimes(2);
    expect(kwil.call).not.toHaveBeenCalled();
  });

  it('refuses view actions, and says why', async () => {
    // A view action is signed because most of them read @caller, so this is a
    // real limit rather than an oversight. Failing here beats failing inside
    // kwil with a null signer.
    const kwil = fakeKwil();
    const client = await BranchClient.connectReadOnly(options(kwil));

    await expect(client.identity.whoami()).rejects.toThrow(BranchError);
    await expect(client.identity.whoami()).rejects.toThrow(/connectReadOnly/);
    expect(kwil.call).not.toHaveBeenCalled();
  });

  it('refuses transactions, and says why', async () => {
    const kwil = fakeKwil();
    const client = await BranchClient.connectReadOnly(options(kwil));

    await expect(client.identity.register('Ada')).rejects.toThrow(BranchError);
    await expect(client.identity.register('Ada')).rejects.toThrow(/connectReadOnly/);
    expect(kwil.execute).not.toHaveBeenCalled();
  });

  it('reads the chain id from the node when it is not given', async () => {
    const kwil = fakeKwil();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { chain_id: 'from-node' } }), { status: 200 })
      );

    await BranchClient.connectReadOnly({
      provider: 'http://node.invalid:8484',
      kwil: kwil as never,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });
});
