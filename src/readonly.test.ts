import { describe, expect, it, vi } from 'vitest';

import { BranchClient } from './client.js';
import { BranchError } from './errors.js';

/**
 * A kwil double that records what it was asked and never needs a signer.
 *
 * BOTH `selectQuery` AND AN UNSIGNED `call` are reachable from a read-only client
 * now. badger-cash/branch#119 moved the read surface onto view actions that do not
 * touch `@caller`, so `call` is reached WITHOUT a signer -- which is the property
 * these tests exist to protect, and the one a signed-out browser depends on.
 * `execute` remains unreachable, because a write needs an account.
 */
const fakeKwil = () => ({
  selectQuery: vi.fn().mockResolvedValue({ data: [{ id: '1' }] }),
  call: vi.fn().mockImplementation((body: { name: string }) => {
    if (body.name === 'current_type_version') {
      return Promise.resolve({
        data: { result: [{ type_id: 1, type_version: 1, type_slug: 'automobile-listing' }] },
      });
    }
    if (body.name === 'metadata_field_custodian_endpoint') {
      return Promise.resolve({ data: { result: [{ url: 'https://custodian.test' }] } });
    }
    if (body.name === 'get_token') {
      return Promise.resolve({
        data: {
          result: [
            {
              token_id: 1,
              name: 'A car',
              state: 'active',
              issuer_person: 'someone',
              created_at: 0,
              identifier: 'make',
              datatype: 'text',
              is_brokered: false,
              custodian_name: null,
              value_text: 'toyota',
              value_number: null,
              value_boolean: null,
              value_datetime: null,
              value_json: null,
            },
          ],
        },
      });
    }
    return Promise.resolve({ data: { result: [] } });
  }),
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
    /*
      UNSIGNED VIEW ACTIONS, and the assertion inverted with #119. This used to
      require two plain SELECTs and NO `call` at all; the read surface is actions
      now, so what matters is that every one of them was called WITHOUT a signer.

      `call` receives one argument when unsigned and two when signed, so the arity
      is the check -- and it is the check, because a read-only client has no signer
      to pass and kwil would reject the message rather than the client.
    */
    const kwil = fakeKwil();
    const client = await BranchClient.connectReadOnly(options(kwil));

    await expect(client.listings.search({ make: 'Toyota' })).resolves.toEqual([]);
    expect(kwil.call).toHaveBeenCalled();
    for (const args of kwil.call.mock.calls) {
      expect(args).toHaveLength(1);
    }
    expect(kwil.execute).not.toHaveBeenCalled();
  });

  it('opens a listing, which is a page further in than browse', async () => {
    // This used to say "view actions are signed", which is FALSE: a PUBLIC VIEW
    // action reading no @caller needs no signer (branch#66, kwil-db
    // core/types/message.go:83). What is true is narrower and is this package's
    // own policy rather than the chain's -- BranchClient.read requires a signer
    // because most view actions do read @caller and it cannot tell which. So
    // the pivot happens in a plain SELECT here, and an anonymous visitor can
    // open a car.
    const kwil = fakeKwil();
    /*
      `get_token`'s LONG FORMAT: the record's identity repeated on every row, plus
      one declared field. The old fake answered one wide SELECT row with a column
      per field, which is the shape that stopped existing when the fourteen joins
      went away.
    */
    const head = {
      token_id: 42,
      name: '2018 Toyota Corolla',
      state: 'active',
      issuer_person: 'Ada Lovelace',
      created_at: 1788224916,
      is_brokered: false,
      custodian_name: null,
    };
    const field = (
      identifier: string,
      value: unknown,
      column: 'value_text' | 'value_number' | 'value_json' = 'value_text'
    ): Record<string, unknown> => ({
      ...head,
      identifier,
      datatype: column === 'value_number' ? 'number' : 'text',
      value_text: null,
      value_number: null,
      value_json: null,
      value_boolean: null,
      value_datetime: null,
      [column]: value,
    });
    kwil.call.mockImplementation((body: { name: string }) => {
      if (body.name === 'get_token') {
        return Promise.resolve({
          data: {
            result: [
              field('make', 'toyota'),
              field('model', 'corolla'),
              field('year', 2018, 'value_number'),
              field('price', '12750', 'value_number'),
              field('price_currency', 'credits'),
              field('location', 'Susupe'),
              field('mileage', 90000, 'value_number'),
              field('vin', '1hgbh41jxmn109186'),
              field('description', 'Runs well.'),
              field('photos', '[]', 'value_json'),
              // The custodian's NAME rides on the brokered field's own row.
              { ...field('contact', null), is_brokered: true, custodian_name: 'CNMI Central' },
            ],
          },
        });
      }
      if (body.name === 'metadata_field_custodian_endpoint') {
        return Promise.resolve({ data: { result: [{ url: 'https://custodian.test' }] } });
      }
      if (body.name === 'current_type_version') {
        return Promise.resolve({
          data: { result: [{ type_id: 1, type_version: 1, type_slug: 'automobile-listing' }] },
        });
      }
      return Promise.resolve({ data: { result: [] } });
    });
    const client = await BranchClient.connectReadOnly(options(kwil));

    const listing = await client.listings.get(42);
    expect(listing?.title).toBe('2018 Toyota Corolla');
    // The custodian's name, never the commitment.
    expect(listing?.contactVia).toBe('CNMI Central');
    expect(listing?.price.units).toBe(127500000000000n);
    // Reached WITHOUT a signer, which is what lets an anonymous visitor open a car.
    for (const args of kwil.call.mock.calls) {
      expect(args).toHaveLength(1);
    }
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
