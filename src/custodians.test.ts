import { describe, expect, it, vi } from 'vitest';

import { BranchClient } from './client.js';
import { BranchError } from './errors.js';
import { objectUrl } from './custodians.js';

/**
 * A kwil double. It records what it was asked and never needs a signer, which
 * is the property under test: resolving a custodian has to work for a
 * signed-out browser.
 *
 * What a double CANNOT establish is that the SQL is right -- it agrees with
 * whatever shape it was written to return. The queries here are checked against
 * a running node separately; these tests cover the calling contract and the
 * pure logic.
 */
/*
  UNSIGNED VIEW ACTIONS, NOT SELECTS. badger-cash/branch#119 moved the custodian
  reads onto `metadata_field_custodian_endpoint`, `group_custodian_endpoint` and
  `person_custodian_endpoint`, so the fake answers `call` and `selectQuery` is
  never reached. `call` is still asserted to be UNSIGNED -- the second argument
  absent -- because that is the property these tests exist for: a signed-out
  browser has to render photographs.
*/
const fakeKwil = (rows: unknown[] = []) => ({
  selectQuery: vi.fn(),
  call: vi.fn().mockResolvedValue({ data: { result: rows } }),
  execute: vi.fn(),
});

const readOnly = (kwil: ReturnType<typeof fakeKwil>) =>
  BranchClient.connectReadOnly({
    provider: 'http://node.invalid:8484',
    chainId: 'test-chain',
    kwil: kwil as never,
  });

describe('custodians', () => {
  it('resolves without a signer, which is the whole point', async () => {
    // A signed-out visitor has to see photographs. If this needed a signer,
    // browse would require an account to render, which is the thing
    // connectReadOnly exists to prevent.
    const kwil = fakeKwil([{ url: 'https://custodian.test', updated_at: 1789 }]);
    const client = await readOnly(kwil);

    const found = await client.custodians.forField('token', 'photos');

    expect(found).toEqual({ url: 'https://custodian.test', updatedAt: 1789n });
    expect(kwil.call).toHaveBeenCalledOnce();
    // UNSIGNED: one argument, so no signer was passed.
    expect(kwil.call.mock.calls[0]).toHaveLength(1);
  });

  it('asks for the photos field by name', async () => {
    const kwil = fakeKwil([{ url: 'https://c.test', updated_at: 1 }]);
    const client = await readOnly(kwil);

    await client.custodians.forField('token', 'photos');

    /*
      THE ACTION AND ITS INPUTS, which is a stronger contract than the SQL text
      this used to assert. $type_id is null here because the caller names
      no type -- the action then matches a network-wide declaration only, and a
      caller that knows its type passes it so the type's own declaration wins.
    */
    const call = kwil.call.mock.calls[0] as unknown as [
      { name: string; inputs: Record<string, unknown> },
    ];
    expect(call[0].name).toBe('metadata_field_custodian_endpoint');
    expect(call[0].inputs).toEqual({
      $type_id: null,
      $entity_type: 'token',
      $identifier: 'photos',
    });
  });

  it('returns null rather than throwing when nobody is reachable', async () => {
    // Three different situations arrive here identically: the field names no
    // custodian, the custodian has never announced, and it has withdrawn. All
    // three mean "you cannot reach this", and a caller has a field name to
    // report either way.
    const client = await readOnly(fakeKwil([]));
    expect(await client.custodians.forField('token', 'photos')).toBeNull();
    expect(await client.custodians.forGroup(1)).toBeNull();
    expect(await client.custodians.forPerson(2)).toBeNull();
  });

  it('treats an empty url as no endpoint', async () => {
    const client = await readOnly(fakeKwil([{ url: '', updated_at: 1 }]));
    expect(await client.custodians.forField('token', 'photos')).toBeNull();
  });

  it('accepts updated_at however INT8 happens to cross', async () => {
    // INT8 arrives as a checked number or a string depending on the path, and
    // the SDK's own README is emphatic that nothing infers to a type by itself.
    for (const at of [1789, '1789', 1789n]) {
      const client = await readOnly(fakeKwil([{ url: 'https://c.test', updated_at: at }]));
      const found = await client.custodians.forField('token', 'photos');
      expect(found?.updatedAt).toBe(1789n);
    }
  });

  it('throws on a non-numeric updated_at rather than reporting no endpoint', async () => {
    // A height that does not parse is a bug. Resolving it to null would present
    // as "the custodian is down", which sends the reader somewhere else
    // entirely.
    const client = await readOnly(fakeKwil([{ url: 'https://c.test', updated_at: {} }]));
    await expect(client.custodians.forField('token', 'photos')).rejects.toThrow(BranchError);
  });
});

describe('objectUrl', () => {
  it('joins an endpoint to an opaque key', () => {
    expect(objectUrl({ url: 'https://c.test', updatedAt: 1n }, 'abc123.jpg')).toBe(
      'https://c.test/objects/abc123.jpg'
    );
  });

  it('takes a bare string endpoint too', () => {
    expect(objectUrl('https://c.test', 'abc123.jpg')).toBe('https://c.test/objects/abc123.jpg');
  });

  it('does not double the slash when an endpoint carries one', () => {
    // The chain refuses a trailing slash, but an endpoint can also arrive from
    // configuration, where nothing has checked it.
    expect(objectUrl('https://c.test/', 'a.jpg')).toBe('https://c.test/objects/a.jpg');
  });

  it('passes an absolute URL through unchanged', () => {
    // Listings published before identifiers replaced URLs carry an absolute
    // address, and those still have to render. Rewriting one against the
    // current custodian would point it at an object that is not there.
    const old = 'http://192.168.1.111:8585/objects/legacy.png';
    expect(objectUrl('https://c.test', old)).toBe(old);
  });

  it('does not parse the key', () => {
    // The custodian owns its naming. An extension today, something else
    // tomorrow, and the chain stores whatever it issued.
    expect(objectUrl('https://c.test', 'no-extension-at-all')).toBe(
      'https://c.test/objects/no-extension-at-all'
    );
  });
});

describe('photos arrive resolved, in one response', () => {
  it('is why the endpoint is joined into the listing queries', () => {
    // The custodian address comes back on the row rather than from a second
    // query. Asking separately costs a round trip per page AND makes a grid
    // paint placeholders first and swap pictures in when the second answer
    // lands. `listings.test.ts` covers the mapping; this records the reason,
    // because the join looks removable to anyone who does not know it.
    expect(objectUrl('https://custodian.test', 'a.jpg')).toBe(
      'https://custodian.test/objects/a.jpg'
    );
  });
});
