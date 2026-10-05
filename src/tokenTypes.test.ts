import { describe, expect, it, vi } from 'vitest';

import { BranchClient } from './client.js';
import { BranchError } from './errors.js';

const VERSION = [
  { type_id: 2, type_version: 1, type_slug: 'automobile-listing', name: 'Automobile Listing' },
];

const declared = (over: Record<string, unknown> = {}) => ({
  identifier: 'make',
  datatype: 'text',
  label: 'Make',
  required: true,
  requires_custodian: false,
  unique_scope: 'none',
  custodian_group_id: null,
  custodian_person_id: null,
  ...over,
});

const fakeKwil = (fields: Record<string, unknown>[] = [declared()]) => ({
  selectQuery: vi.fn().mockResolvedValue({ data: [] }),
  call: vi.fn().mockImplementation((body: { name: string }) => {
    if (body.name === 'current_type_version') return Promise.resolve({ data: { result: VERSION } });
    if (body.name === 'token_type_schema') return Promise.resolve({ data: { result: fields } });
    if (body.name === 'token_version_schema') return Promise.resolve({ data: { result: fields } });
    return Promise.resolve({ data: { result: [] } });
  }),
  execute: vi.fn(),
});

const connect = async (kwil: ReturnType<typeof fakeKwil>) =>
  await BranchClient.connectReadOnly({
    provider: 'http://node.invalid:8484',
    chainId: 'test-chain',
    kwil: kwil as never,
  });

const names = (kwil: ReturnType<typeof fakeKwil>): string[] =>
  kwil.call.mock.calls.map((c) => (c[0] as { name: string }).name);

describe('types.schema', () => {
  it('carries the version alongside the declarations', async () => {
    // A caller needs the id to mint and the version to pin, and
    // token_type_schema returns neither.
    const kwil = fakeKwil();
    const client = await connect(kwil);

    const schema = await client.types.schema('automobile-listing');
    expect(schema.typeId).toBe(2);
    expect(schema.typeVersion).toBe(1);
    expect(schema.typeSlug).toBe('automobile-listing');
    expect(schema.fields).toHaveLength(1);
    expect(names(kwil).sort()).toEqual(['current_type_version', 'token_type_schema']);
  });

  it('projects every column a generated filter needs', async () => {
    const kwil = fakeKwil([
      declared({ identifier: 'year', datatype: 'number', label: 'Year', required: false }),
      declared({
        identifier: 'contact',
        datatype: 'json',
        label: 'Contact',
        requires_custodian: true,
        custodian_group_id: 1,
      }),
      declared({ identifier: 'vin', label: 'VIN', unique_scope: 'type_active' }),
    ]);
    const client = await connect(kwil);

    const { fields } = await client.types.schema('automobile-listing');
    expect(fields[0]).toEqual({
      identifier: 'year',
      datatype: 'number',
      label: 'Year',
      required: false,
      requiresCustodian: false,
      uniqueScope: 'none',
      custodianGroupId: null,
      custodianPersonId: null,
    });
    // A brokered field must be renderable as "ask the custodian" rather than blank.
    expect(fields[1]?.requiresCustodian).toBe(true);
    expect(fields[1]?.custodianGroupId).toBe(1);
    // The scope that expresses "unique among ACTIVE records".
    expect(fields[2]?.uniqueScope).toBe('type_active');
  });

  it('caches nothing, so a page cannot be pinned to a stale version', async () => {
    /*
      THIS IS #44. `listings.ts` caches one type id for the client's lifetime,
      which pins a page to whichever version was live when it loaded. A schema is
      fetched once per render rather than once per card, so the call is cheap and
      the staleness is not worth buying.

      Fails if anybody adds a cache.
    */
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.types.schema('automobile-listing');
    await client.types.schema('automobile-listing');

    expect(names(kwil).filter((n) => n === 'current_type_version')).toHaveLength(2);
  });

  it('is reached without a signer', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.types.schema('automobile-listing');
    for (const args of kwil.call.mock.calls) expect(args).toHaveLength(1);
  });

  it('refuses a datatype the chain should not be able to produce', async () => {
    // The vocabulary is CHECK-constrained on chain, so an unknown value means
    // this package is out of date rather than that the row is odd. Loud beats
    // silently mistyped -- the same choice credits.ts makes for entry kinds.
    const kwil = fakeKwil([declared({ datatype: 'geography' })]);
    const client = await connect(kwil);

    await expect(client.types.schema('x')).rejects.toThrow(/unrecognised field datatype/);
  });

  it('refuses an unknown unique scope', async () => {
    const kwil = fakeKwil([declared({ unique_scope: 'per_island' })]);
    const client = await connect(kwil);

    await expect(client.types.schema('x')).rejects.toThrow(/unrecognised unique scope/);
  });
});

describe('types.current', () => {
  it('says so when the family is not on this chain', async () => {
    const kwil = fakeKwil();
    kwil.call.mockResolvedValue({ data: { result: [] } });
    const client = await connect(kwil);

    await expect(client.types.current('no-such-family')).rejects.toThrow(BranchError);
    await expect(client.types.current('no-such-family')).rejects.toThrow(/no-such-family/);
  });
});

describe('types.versionSchema', () => {
  it('asks by type id, which is what a record carries', async () => {
    /*
      `schema()` answers for the CURRENT version, which is wrong for a client
      holding an older record: the current ABI would claim a field the record
      cannot have, or hide one it does. get_token returns the record's own
      type_id, so this takes that.
    */
    const kwil = fakeKwil([declared()]);
    const client = await connect(kwil);

    const fields = await client.types.versionSchema(7);
    expect(fields).toHaveLength(1);
    const call = kwil.call.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'token_version_schema'
    );
    expect((call?.[0] as { inputs: Record<string, unknown> }).inputs.$type_id).toBe(7);
    // No version lookup: the id already identifies a version.
    expect(names(kwil)).not.toContain('current_type_version');
  });
});
