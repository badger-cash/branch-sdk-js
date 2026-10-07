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
      THIS IS #44. The deleted `listings.ts` cached one type id for the client's
      lifetime,
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

describe('types.feeTiers', () => {
  const withTiers = (rows: Array<{ identifier: unknown; fee: unknown }>) => ({
    selectQuery: vi.fn().mockResolvedValue({ data: [] }),
    call: vi
      .fn()
      .mockImplementation((body: { name: string }) =>
        body.name === 'type_fee_tiers'
          ? Promise.resolve({ data: { result: rows } })
          : Promise.resolve({ data: { result: [] } })
      ),
    execute: vi.fn(),
  });

  it('is cheapest first, whatever order the chain returns', async () => {
    const kwil = withTiers([
      { identifier: 'fee_180d', fee: '3.0000000000' },
      { identifier: 'fee_7d', fee: '1.0000000000' },
      { identifier: 'fee_30d', fee: '1.0000000000' },
    ]);
    const client = await connect(kwil);

    const tiers = await client.types.feeTiers('automobile-listing');
    expect(tiers.map((t) => t.durationDays)).toEqual([7, 30, 180]);
  });

  it('rounds to whole credits, the way the ledger charges them', async () => {
    /*
      SCALE 0, NOT 10. The stored rate is NUMERIC(38,10) but `listing_fee`
      returns NUMERIC(78,0) and the ledger has scale 0. Handing back the
      scale-10 figure gives `units` a thousand million times larger than a
      balance's, and the comparison then passes on an empty account.

      3.2 rounds to 3 — half away from zero, as Postgres casts, not as
      Math.round would.
    */
    const kwil = withTiers([{ identifier: 'fee_180d', fee: '3.2000000000' }]);
    const client = await connect(kwil);

    const [tier] = await client.types.feeTiers('automobile-listing');
    expect(tier?.fee).toEqual({ units: 3n, decimals: 0 });
  });

  it('returns nothing for a type that is curated rather than sold', async () => {
    /*
      GOVERNMENT. "No tiers" is not "free", and a caller must be able to tell
      them apart — an empty array says the type sells no durations at all.
    */
    const kwil = withTiers([]);
    const client = await connect(kwil);

    await expect(client.types.feeTiers('government-notice')).resolves.toEqual([]);
  });

  it('skips an identifier that is not a tier rather than guessing at it', async () => {
    // `_` is a single-character wildcard, so a LIKE 'fee_%d' would also match
    // `feeXd`. The grammar is stated exactly, and a row outside it is skipped.
    const kwil = withTiers([
      { identifier: 'fee_30d', fee: '1.0000000000' },
      { identifier: 'feeXd', fee: '9.0000000000' },
      { identifier: 'photos', fee: '0.0000000000' },
      { identifier: 'fee_d', fee: '9.0000000000' },
    ]);
    const client = await connect(kwil);

    const tiers = await client.types.feeTiers('automobile-listing');
    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.durationDays).toBe(30);
  });

  it('asks about the type it was given, not a hardcoded one', async () => {
    const kwil = withTiers([]);
    const client = await connect(kwil);

    await client.types.feeTiers('everyday-item');
    const call = kwil.call.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'type_fee_tiers'
    );
    expect((call?.[0] as { inputs: Record<string, unknown> }).inputs.$type_slug).toBe(
      'everyday-item'
    );
    // Unsigned: a seller sees the price before signing anything.
    for (const args of kwil.call.mock.calls) expect(args).toHaveLength(1);
  });
});

describe('declaring a directory', () => {
  const signing = async (version = VERSION) => {
    const writes: Array<{ name: string; inputs: Record<string, unknown>; types?: unknown }> = [];
    const kwil = {
      execute(body: { name: string; inputs: Record<string, unknown>[]; types?: unknown }) {
        writes.push({ name: body.name, inputs: body.inputs[0] ?? {}, types: body.types });
        return Promise.resolve({ data: { tx_hash: '0xabc' } });
      },
      call: (body: { name: string }) =>
        Promise.resolve({
          data: { result: body.name === 'current_type_version' ? version : [] },
        }),
      selectQuery: () => Promise.resolve({ data: [] }),
    };
    const client = await BranchClient.connect({
      provider: 'http://example.invalid',
      chainId: 'test-chain',
      address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      signer: { signMessage: () => Promise.resolve('0x00') },
      kwil: kwil as never,
    });
    return { client, writes };
  };

  const TYPE = {
    slug: 'everyday-item',
    name: 'Everyday Item',
    description: 'A classified advertisement for a used good.',
    issuerKind: 'person' as const,
    initialStateName: 'active',
    initialStateLabel: 'Active',
    mintPolicy: 'fee',
  };

  it('creates a type and resolves its id through an action, not a SELECT', async () => {
    /*
      `create_token_type` RETURNS NOTHING. seed-cars.sh reads the id back with
      `SELECT id FROM token_types WHERE live_slug = ...`; a consumer of this
      package never SELECTs a chain table, so this resolves it through
      `current_type_version` -- which also means the id is the one `live_slug`
      resolves to rather than whatever a raw query happened to return.
    */
    const { client, writes } = await signing();

    const version = await client.types.create(TYPE);

    expect(writes[0]?.name).toBe('create_token_type');
    expect(version.typeId).toBe(2);
    expect(version.typeSlug).toBe('automobile-listing');
  });

  it('declares the nullable INT8s, because a null does not infer', async () => {
    /*
      A NON-NULL NUMBER INFERS AND A NULL ONE DOES NOT. kwil-js reads a
      parameter's type from its value, and `null` falls into the NULL case -- so an
      omitted `governingRoleId` would be sent typeless and refused against a
      declared INT8. seed-cars.sh writes `int8:null` for the same reason.
    */
    const { client, writes } = await signing();

    await client.types.create(TYPE);

    const types = writes[0]?.types as Record<string, unknown>;
    expect(types.$governing_role_id).toBeDefined();
    expect(types.$moderating_role_id).toBeDefined();
    expect(writes[0]?.inputs.$governing_role_id).toBeNull();
    expect(writes[0]?.inputs.$moderating_role_id).toBeNull();
  });

  it('defaults a directory to a non-fungible, untransferable, public record', async () => {
    // A classified ad is one thing, not a quantity of them, and it is published to
    // be seen. A caller that wants otherwise says so.
    const { client, writes } = await signing();

    await client.types.create(TYPE);

    expect(writes[0]?.inputs.$is_fungible).toBe(false);
    expect(writes[0]?.inputs.$transferable).toBe(false);
    expect(writes[0]?.inputs.$visibility).toBe('public');
  });

  it('declares a state ordinal as INT8, because a signature cannot say INT4', async () => {
    // `token_type_states.ordinal` is INT4 and the parser ACCEPTS `INT4` in a
    // signature while the engine then refuses the call (branch, gotcha 5). The
    // action declares INT8 and casts, so this must too.
    const { client, writes } = await signing();

    await client.types.addState(2, { name: 'sold', label: 'Sold', ordinal: 2, isTerminal: true });

    expect(writes[0]?.name).toBe('add_type_state');
    expect((writes[0]?.types as Record<string, unknown>).$ordinal).toBeDefined();
    expect(writes[0]?.inputs.$is_terminal).toBe(true);
  });

  it('declares every field in one transaction, as nine parallel arrays', async () => {
    /*
      ONE TRANSACTION, because the officeholder key can sign only one at a time
      (#11) and twenty fields declared separately would be twenty.

      NINE ARRAYS MATCHED BY POSITION, every one type-declared: nothing infers,
      and an empty array infers to `null[]`.
    */
    const { client, writes } = await signing();

    await client.types.declareFields(2, [
      { identifier: 'category', datatype: 'text', label: 'Category', required: true, folded: true },
      { identifier: 'price', datatype: 'number', label: 'Price', required: true },
      {
        identifier: 'contact',
        datatype: 'json',
        label: 'Contact',
        brokered: true,
        custodianGroupId: 1,
      },
    ]);

    const i = writes[0]?.inputs as Record<string, unknown>;
    expect(writes[0]?.name).toBe('declare_type_fields');
    expect(i.$identifiers).toEqual(['category', 'price', 'contact']);
    expect(i.$datatypes).toEqual(['text', 'number', 'json']);
    expect(i.$required).toEqual([true, true, false]);
    expect(i.$unique_scopes).toEqual(['none', 'none', 'none']);
    expect(i.$brokered).toEqual([false, false, true]);
    expect(i.$custodian_groups).toEqual([null, null, 1]);
    expect(i.$folded).toEqual([true, false, false]);

    const types = writes[0]?.types as Record<string, unknown>;
    for (const key of [
      '$identifiers',
      '$datatypes',
      '$labels',
      '$required',
      '$unique_scopes',
      '$brokered',
      '$custodian_groups',
      '$folded',
    ]) {
      expect(types[key], key).toBeDefined();
    }
  });

  it('sends folded as declared rather than leaving it to a convention', async () => {
    /*
      DECLARE IT OR FILTERS SILENTLY MATCH NOTHING. `make` and `model` fold so a
      filter is a bare equality; `location` and `description` do not. This was an
      unwritten rule inside one directory's own write action before branch#56 made
      it data, which meant a directory whose author did not know it got filters
      that matched nothing and errored nowhere.
    */
    const { client, writes } = await signing();

    await client.types.declareFields(2, [
      { identifier: 'make', datatype: 'text', label: 'Make', folded: true },
      { identifier: 'location', datatype: 'text', label: 'Location' },
    ]);

    expect(writes[0]?.inputs.$folded).toEqual([true, false]);
  });

  it('refuses to declare no fields at all', async () => {
    const { client, writes } = await signing();

    await expect(client.types.declareFields(2, [])).rejects.toThrow(BranchError);
    expect(writes).toHaveLength(0);
  });

  it('attaches a validation rule or a brokered structure template', async () => {
    const { client, writes } = await signing();

    await client.types.setFieldValidation(2, 'contact', '{"$schema":"contact/v1"}');

    expect(writes[0]?.name).toBe('set_field_validation');
    expect(writes[0]?.inputs).toEqual({
      $type_id: 2,
      $identifier: 'contact',
      $validation: '{"$schema":"contact/v1"}',
    });
  });

  it('names the state a lapsed record moves to', async () => {
    const { client, writes } = await signing();

    await client.types.setExpiryState(2, 'expired');

    expect(writes[0]?.name).toBe('set_type_expiry_state');
    expect(writes[0]?.inputs).toEqual({ $type_id: 2, $state_name: 'expired' });
  });

  it('names the holder that collects the fees, and declares a term', async () => {
    const { client, writes } = await signing();

    await client.types.setFeeHolder(2, 4);
    await client.types.declareFeeDuration(30);

    expect(writes[0]?.inputs).toEqual({ $type_id: 2, $holder_id: 4 });
    expect(writes[1]?.name).toBe('declare_fee_duration');
    expect(writes[1]?.inputs).toEqual({ $duration_days: 30 });
    // A term is network-wide, so it takes no type.
    expect(writes[1]?.inputs).not.toHaveProperty('$type_id');
  });

  it('refuses an id past MAX_SAFE_INTEGER rather than losing precision', async () => {
    const { client } = await signing();
    await expect(client.types.setFeeHolder(2, 9007199254740993n)).rejects.toThrow(BranchError);
  });
});

describe('types.fieldValues', () => {
  const VALUES = [
    { identifier: 'make', value_text: 'toyota', n: 4 },
    { identifier: 'make', value_text: 'honda', n: 3 },
    { identifier: 'condition', value_text: 'used', n: 10 },
  ];

  const withValues = (rows: Array<Record<string, unknown>> = VALUES) => ({
    selectQuery: vi.fn().mockResolvedValue({ data: [] }),
    call: vi
      .fn()
      .mockImplementation((body: { name: string }) =>
        body.name === 'type_field_values'
          ? Promise.resolve({ data: { result: rows } })
          : Promise.resolve({ data: { result: [] } })
      ),
    execute: vi.fn(),
  });

  const inputsOf = (kwil: ReturnType<typeof withValues>): Record<string, unknown> => {
    const call = kwil.call.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'type_field_values'
    );
    return (call?.[0] as { inputs: Record<string, unknown> }).inputs;
  };

  it('asks type_field_values for every identifier in one call', async () => {
    // ONE CALL, not one per facet. Six would be the per-item round trip
    // badger-cash/branch-sdk-js#49 removed from the grid, moved to the sidebar.
    const kwil = withValues();
    const client = await connect(kwil);

    await client.types.fieldValues('automobile-listing', ['make', 'condition']);

    expect(kwil.call.mock.calls).toHaveLength(1);
    const inputs = inputsOf(kwil);
    expect(inputs.$type_slug).toBe('automobile-listing');
    expect(inputs.$identifiers).toEqual(['make', 'condition']);
  });

  it('caps the value set by default, and the cap is overridable', async () => {
    const kwil = withValues();
    const client = await connect(kwil);

    await client.types.fieldValues('automobile-listing', ['make']);
    expect(inputsOf(kwil).$max_values).toBe(50);

    const other = withValues();
    const client2 = await connect(other);
    await client2.types.fieldValues('automobile-listing', ['make'], { maxValues: 8 });
    expect(inputsOf(other).$max_values).toBe(8);
  });

  it('leaves the version unpinned unless asked, as a null rather than a zero', async () => {
    // search_tokens passes its own the same way: null is "whichever version each
    // record is", and a 0 would be a version that does not exist.
    const kwil = withValues();
    const client = await connect(kwil);
    await client.types.fieldValues('automobile-listing', ['make']);
    expect(inputsOf(kwil).$type_version).toBeNull();

    const pinned = withValues();
    const client2 = await connect(pinned);
    await client2.types.fieldValues('automobile-listing', ['make'], { typeVersion: 1 });
    expect(inputsOf(pinned).$type_version).toBe(1);
  });

  it('groups the values under their own field, in the order returned', async () => {
    const kwil = withValues();
    const client = await connect(kwil);

    const byField = await client.types.fieldValues('automobile-listing', ['make', 'condition']);

    expect(byField.get('make')).toEqual([
      { value: 'toyota', count: 4 },
      { value: 'honda', count: 3 },
    ]);
    expect(byField.get('condition')).toEqual([{ value: 'used', count: 10 }]);
  });

  it('OMITS a field the chain said nothing about, rather than giving it an empty list', async () => {
    // THE DISTINCTION THE WHOLE FEATURE TURNS ON. No rows means "more distinct
    // values than the cap -- render a text input", which is not the same claim as
    // "this field has no values yet". A caller that conflates them renders an
    // empty select for `location` and a text input for nothing.
    const kwil = withValues([{ identifier: 'make', value_text: 'toyota', n: 4 }]);
    const client = await connect(kwil);

    const byField = await client.types.fieldValues('automobile-listing', ['make', 'location']);

    expect(byField.has('make')).toBe(true);
    expect(byField.has('location')).toBe(false);
    expect(byField.get('location')).toBeUndefined();
  });

  it('never returns a field present and empty', async () => {
    // The corollary, asserted separately because it is what lets a caller use
    // `has()` as the whole decision.
    const kwil = withValues();
    const client = await connect(kwil);

    const byField = await client.types.fieldValues('automobile-listing', [
      'make',
      'condition',
      'description',
      'contact',
    ]);

    for (const [, options] of byField) expect(options.length).toBeGreaterThan(0);
  });

  it('hands back a folded value exactly as stored, because it is a search needle', async () => {
    // `make` folds, so the chain holds `toyota`. Prettifying it here would
    // produce an option that matches nothing when sent back as a filter.
    const kwil = withValues([{ identifier: 'make', value_text: 'toyota', n: 4 }]);
    const client = await connect(kwil);

    const byField = await client.types.fieldValues('automobile-listing', ['make']);
    expect(byField.get('make')?.[0]?.value).toBe('toyota');
  });

  it('costs no round trip when asked about nothing', async () => {
    // As tokens.fields() does with no ids: an empty question is answered here.
    const kwil = withValues();
    const client = await connect(kwil);

    const byField = await client.types.fieldValues('automobile-listing', []);

    expect(byField.size).toBe(0);
    expect(kwil.call).not.toHaveBeenCalled();
  });

  it('reads the count as a number, since it is a tally and not an amount', async () => {
    const kwil = withValues([{ identifier: 'make', value_text: 'toyota', n: '4' }]);
    const client = await connect(kwil);

    const byField = await client.types.fieldValues('automobile-listing', ['make']);
    expect(byField.get('make')?.[0]?.count).toBe(4);
  });
});
