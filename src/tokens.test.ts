import { describe, expect, it, vi } from 'vitest';

import { BranchClient } from './client.js';
import { BranchError } from './errors.js';

/*
  A kwil double that records what it was asked.

  WRITTEN TO BE ABLE TO FAIL. branch/CLAUDE.md records what happens otherwise: a
  double built from an assumption confirms the assumption rather than the system.
  So every assertion here is about the SHAPE OF THE CALL -- which parameters are
  sent, with which values and which declared types -- because that shape is what
  a running node accepts or refuses, and it is what a fake cannot fake away.
*/
const fakeKwil = () => ({
  selectQuery: vi.fn().mockResolvedValue({ data: [] }),
  call: vi.fn().mockResolvedValue({ data: { result: [] } }),
  execute: vi.fn().mockResolvedValue({ data: { tx_hash: '0xdead' } }),
});

const connect = async (kwil: ReturnType<typeof fakeKwil>) =>
  await BranchClient.connectReadOnly({
    provider: 'http://node.invalid:8484',
    chainId: 'test-chain',
    kwil: kwil as never,
  });

const inputsOf = (kwil: ReturnType<typeof fakeKwil>, action: string): Record<string, unknown> => {
  const hit = kwil.call.mock.calls.find((c) => (c[0] as { name: string }).name === action);
  if (hit === undefined) throw new Error(`no call to ${action}`);
  return (hit[0] as { inputs: Record<string, unknown> }).inputs;
};

describe('tokens.search', () => {
  it('passes a text needle through untouched, because the node folds it', async () => {
    /*
      THE CORRECTION THIS CLIENT MADE. The deleted `listings.search` lowercased
      needles. The
      node already does it, per declaration:
        m.value_text = CASE WHEN d.folded THEN lower(q.v) ELSE q.v END
      so lowercasing here is redundant for a folded field and WRONG for one
      declared unfolded -- it turns an exact search into one that cannot match.

      This test fails if anybody reintroduces .toLowerCase().
    */
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.tokens.search('automobile-listing', {
      text: [{ identifier: 'make', value: 'Toyota' }],
    });

    expect(inputsOf(kwil, 'search_tokens').$text_values).toEqual(['Toyota']);
  });

  it('trims a needle, and drops one that is only whitespace', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.tokens.search('automobile-listing', {
      text: [
        { identifier: 'make', value: '  Toyota  ' },
        { identifier: 'model', value: '   ' },
      ],
    });

    const inputs = inputsOf(kwil, 'search_tokens');
    expect(inputs.$text_keys).toEqual(['make']);
    expect(inputs.$text_values).toEqual(['Toyota']);
  });

  it('sends null rather than an empty array, because [] infers to null[]', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.tokens.search('automobile-listing');

    const inputs = inputsOf(kwil, 'search_tokens');
    for (const key of [
      '$text_keys',
      '$text_values',
      '$number_keys',
      '$number_mins',
      '$number_maxs',
      '$boolean_keys',
      '$boolean_values',
    ]) {
      expect(inputs[key], key).toBeNull();
    }
  });

  it('sends bounds as decimal strings, with null for the unbounded side', async () => {
    /*
      WHY TEXT AND NOT NUMERIC(38,10)[]. An array whose elements are ALL NULL
      arrives as numeric(0,0)[] and is refused -- which is exactly what
      `year >= 2015` with no upper bound produces. Only a running node revealed
      it; a fake accepted the broken shape happily, which is why this asserts
      strings rather than numbers.
    */
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.tokens.search('automobile-listing', {
      ranges: [
        { identifier: 'year', min: 2015 },
        { identifier: 'price', max: '20000.50' },
      ],
    });

    const inputs = inputsOf(kwil, 'search_tokens');
    expect(inputs.$number_keys).toEqual(['year', 'price']);
    expect(inputs.$number_mins).toEqual(['2015', null]);
    expect(inputs.$number_maxs).toEqual([null, '20000.50']);
  });

  it('drops a range facet with neither bound', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.tokens.search('t', { ranges: [{ identifier: 'year' }] });

    expect(inputsOf(kwil, 'search_tokens').$number_keys).toBeNull();
  });

  it('refuses a bound that is not a decimal, before it reaches the planner', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await expect(
      client.tokens.search('t', {
        ranges: [{ identifier: 'year', min: '2015; DROP TABLE tokens' }],
      })
    ).rejects.toThrow(BranchError);
    expect(kwil.call).not.toHaveBeenCalled();
  });

  it('sends an explicit false boolean facet rather than dropping it', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.tokens.search('t', { booleans: [{ identifier: 'accepts_trade', value: false }] });

    const inputs = inputsOf(kwil, 'search_tokens');
    expect(inputs.$boolean_keys).toEqual(['accepts_trade']);
    expect(inputs.$boolean_values).toEqual([false]);
  });

  it('is reached without a signer, so an anonymous visitor can browse', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await client.tokens.search('t');

    expect(kwil.call).toHaveBeenCalled();
    for (const args of kwil.call.mock.calls) expect(args).toHaveLength(1);
    expect(kwil.execute).not.toHaveBeenCalled();
  });

  it('projects a hit, converting created_at from epoch seconds', async () => {
    const kwil = fakeKwil();
    kwil.call.mockResolvedValue({
      data: {
        result: [
          {
            token_id: 12,
            name: '2018 Toyota Corolla',
            state: 'active',
            created_at: 1790680556,
            type_id: 2,
            type_version: 1,
          },
        ],
      },
    });
    const client = await connect(kwil);

    const hits = await client.tokens.search('automobile-listing');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.tokenId).toBe(12n);
    expect(hits[0]?.createdAt.getTime()).toBe(1790680556 * 1000);
  });
});

describe('tokens.fields', () => {
  it('makes no call for no ids', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);

    await expect(client.tokens.fields([])).resolves.toEqual(new Map());
    expect(kwil.call).not.toHaveBeenCalled();
  });

  it('groups by token and keys by identifier, keeping the row custodian url', async () => {
    // THE SECOND OF TWO ROUND TRIPS. `custodian_url` arrives per row, which is
    // what makes a third call for a photo base unnecessary (#49).
    const kwil = fakeKwil();
    const row = (token: number, identifier: string, text: string | null, url: string | null) => ({
      token_id: token,
      identifier,
      datatype: 'text',
      value_text: text,
      value_number: null,
      value_boolean: null,
      value_datetime: null,
      value_json: null,
      value_hmac: null,
      custodian_url: url,
    });
    kwil.call.mockResolvedValue({
      data: {
        result: [
          row(12, 'make', 'toyota', null),
          row(12, 'photos', '[]', 'https://custodian.test'),
          row(13, 'make', 'honda', null),
        ],
      },
    });
    const client = await connect(kwil);

    const got = await client.tokens.fields([12n, 13n]);
    expect([...got.keys()]).toEqual(['12', '13']);
    expect(got.get('12')?.get('make')?.text).toBe('toyota');
    expect(got.get('12')?.get('photos')?.custodianUrl).toBe('https://custodian.test');
    expect(got.get('13')?.size).toBe(1);
  });
});

describe('tokens.get', () => {
  const head = {
    token_id: 42,
    name: '2018 Toyota Corolla',
    state: 'active',
    is_terminal: false,
    type_id: 2,
    type_slug: 'automobile-listing',
    type_version: 1,
    created_at: 1790680556,
    issuer_person: 'Marianas Motors',
    issuer_group: null,
  };
  const field = (identifier: string, extra: Record<string, unknown>) => ({
    ...head,
    identifier,
    datatype: 'text',
    value_text: null,
    value_number: null,
    value_boolean: null,
    value_datetime: null,
    value_json: null,
    value_hmac: null,
    custodian_url: null,
    is_brokered: false,
    custodian_name: null,
    ...extra,
  });

  it('collapses long format into one record and a field map', async () => {
    const kwil = fakeKwil();
    kwil.call.mockResolvedValue({
      data: {
        result: [
          field('make', { value_text: 'toyota' }),
          field('year', { datatype: 'number', value_number: '2018' }),
          field('contact', {
            is_brokered: true,
            value_hmac: 'ab12',
            custodian_name: 'CNMI Central',
            custodian_url: 'https://custodian.test',
          }),
        ],
      },
    });
    const client = await connect(kwil);

    const rec = await client.tokens.get(42);
    expect(rec?.name).toBe('2018 Toyota Corolla');
    // The issuer's on-chain display_name, which regressed to a raw handle once.
    expect(rec?.issuerPerson).toBe('Marianas Motors');
    expect(rec?.fields.size).toBe(3);
    expect(rec?.fields.get('year')?.number).toBe('2018');
    // THE COMMITMENT, NEVER THE VALUE.
    expect(rec?.fields.get('contact')?.hmacHex).toBe('ab12');
    expect(rec?.fields.get('contact')?.text).toBeNull();
    expect(rec?.fields.get('contact')?.custodianUrl).toBe('https://custodian.test');
  });

  it('returns null when the record does not exist', async () => {
    const kwil = fakeKwil();
    const client = await connect(kwil);
    await expect(client.tokens.get(999)).resolves.toBeNull();
  });

  it('survives a record with no declared fields', async () => {
    // get_token still returns one row, with a null identifier. Skipping it is
    // the difference between an empty map and a throw.
    const kwil = fakeKwil();
    kwil.call.mockResolvedValue({ data: { result: [field('', { identifier: null })] } });
    const client = await connect(kwil);

    const rec = await client.tokens.get(42);
    expect(rec?.fields.size).toBe(0);
    expect(rec?.name).toBe('2018 Toyota Corolla');
  });
});

describe('tokens.mint', () => {
  const signing = async () => {
    const writes: Array<{ name: string; inputs: Record<string, unknown>; types?: unknown }> = [];
    const kwil = {
      execute(body: { name: string; inputs: Record<string, unknown>[]; types?: unknown }) {
        writes.push({ name: body.name, inputs: body.inputs[0] ?? {}, types: body.types });
        return Promise.resolve({ data: { tx_hash: '0xabc' } });
      },
      call: () => Promise.resolve({ data: { result: [] } }),
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

  const base = { typeId: 2, stateName: 'active', name: 'A record' };

  it('omits an absent boolean and sends an explicit false', async () => {
    /*
      AN UNANSWERED QUESTION AND A REFUSAL ARE DIFFERENT. Omitting the key writes
      no row; `false` writes one saying so. Collapsing them would tell a reader
      somebody refused when nobody was asked.
    */
    const { client, writes } = await signing();

    await client.tokens.mint({
      ...base,
      booleans: { accepts_offers: false, accepts_trade: undefined },
    });

    expect(writes[0]?.inputs.$boolean_keys).toEqual(['accepts_offers']);
    expect(writes[0]?.inputs.$boolean_values).toEqual([false]);
  });

  it('declares the array and numeric types, because nothing infers to NUMERIC', async () => {
    // An empty array infers to null[] and an undeclared numeric is refused. This
    // asserts the declarations exist rather than that they happen to work.
    const { client, writes } = await signing();

    await client.tokens.mint({ ...base, numbers: { price: '12750' } });

    const types = writes[0]?.types as Record<string, unknown>;
    for (const key of [
      '$text_keys',
      '$text_values',
      '$number_keys',
      '$number_values',
      '$boolean_keys',
      '$boolean_values',
      '$datetime_keys',
      '$datetime_values',
      '$json_keys',
      '$json_values',
      '$brokered_keys',
      '$brokered_hmacs',
      '$quantity',
    ]) {
      expect(types[key], key).toBeDefined();
    }
    expect(writes[0]?.inputs.$number_values).toEqual(['12750']);
  });

  it('refuses a number that is not a decimal', async () => {
    const { client, writes } = await signing();

    await expect(
      client.tokens.mint({ ...base, numbers: { price: 'twelve thousand' } })
    ).rejects.toThrow(BranchError);
    expect(writes).toHaveLength(0);
  });

  it('carries a commitment for a brokered field, never a value', async () => {
    const { client, writes } = await signing();

    await client.tokens.mint({ ...base, brokered: { contact: 'ab12cd34' } });

    expect(writes[0]?.inputs.$brokered_keys).toEqual(['contact']);
    expect(writes[0]?.inputs.$brokered_hmacs).toEqual(['ab12cd34']);
    // The value never travels under its identifier.
    expect(writes[0]?.inputs.$text_keys).toEqual([]);
  });

  it('refuses a commitment that is not hex', async () => {
    // A non-hex commitment is almost certainly a plaintext contact detail reaching
    // for the brokered slot, which is the one mistake that puts personal data on a
    // permanent public ledger.
    const { client, writes } = await signing();

    await expect(
      client.tokens.mint({ ...base, brokered: { contact: '+1 670 555 0100' } })
    ).rejects.toThrow(/hex/);
    expect(writes).toHaveLength(0);
  });

  it('serialises a json field and drops an empty text value', async () => {
    const { client, writes } = await signing();

    await client.tokens.mint({
      ...base,
      text: { make: 'toyota', model: '   ', description: undefined },
      json: { photos: ['a.jpg', 'b.jpg'] },
    });

    expect(writes[0]?.inputs.$text_keys).toEqual(['make']);
    expect(writes[0]?.inputs.$json_keys).toEqual(['photos']);
    expect(writes[0]?.inputs.$json_values).toEqual(['["a.jpg","b.jpg"]']);
  });

  it('defaults holder, group and settlement to null so the chain resolves them', async () => {
    // The issuer holds their own record: the mint resolves their holder from
    // @caller when this is null.
    const { client, writes } = await signing();

    await client.tokens.mint(base);

    expect(writes[0]?.inputs.$to_holder_id).toBeNull();
    expect(writes[0]?.inputs.$as_group_id).toBeNull();
    expect(writes[0]?.inputs.$settlement_id).toBeNull();
  });
});

describe('tokens transitions', () => {
  const signing = async () => {
    const writes: Array<{ name: string; inputs: Record<string, unknown> }> = [];
    const kwil = {
      execute(body: { name: string; inputs: Record<string, unknown>[] }) {
        writes.push({ name: body.name, inputs: body.inputs[0] ?? {} });
        return Promise.resolve({ data: { tx_hash: '0xabc' } });
      },
      call: () => Promise.resolve({ data: { result: [] } }),
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

  it('sends the state name a caller chose, whatever it is', async () => {
    /*
      THE POINT OF #53. An event is `cancelled` and a business is `closed`;
      neither is expressible through `ListingOutcome = 'sold' | 'withdrawn'`.
      This passes the name through so a type nobody here has heard of works.
    */
    const { client, writes } = await signing();

    await client.tokens.close(12, 'cancelled');

    expect(writes[0]?.name).toBe('close_token');
    expect(writes[0]?.inputs).toEqual({ $token_id: 12, $state_name: 'cancelled' });
  });

  it('does not pre-validate the state name, because the chain owns that rule', async () => {
    /*
      DELIBERATELY NO CLIENT-SIDE CHECK. `type_state` errors with `this type has
      no state named X` and that arrives as ActionFailedError.log -- the message
      worth showing a user. A second implementation here could disagree with the
      chain, which is worse than none.

      So a nonsense state must still REACH the node. This fails if anybody adds
      a vocabulary guard.
    */
    const { client, writes } = await signing();

    await client.tokens.close(12, 'not-a-state-on-any-type');

    expect(writes).toHaveLength(1);
    expect(writes[0]?.inputs.$state_name).toBe('not-a-state-on-any-type');
  });

  it('moderates with a state and a mandatory reason', async () => {
    const { client, writes } = await signing();

    await client.tokens.moderate(12n, 'withdrawn', 'duplicate listing');

    expect(writes[0]?.name).toBe('moderate_token');
    expect(writes[0]?.inputs).toEqual({
      $token_id: 12,
      $state_name: 'withdrawn',
      $reason: 'duplicate listing',
    });
  });

  it('expires without a state name, because the type configures which one', async () => {
    // `expire_token` reads the type's own expiry state through
    // `type_expiry_state`, so it is configuration rather than a caller's choice.
    const { client, writes } = await signing();

    await client.tokens.expire(12);

    expect(writes[0]?.name).toBe('expire_token');
    expect(writes[0]?.inputs).toEqual({ $token_id: 12 });
  });

  it('accepts a bigint or a number id alike', async () => {
    const { client, writes } = await signing();

    await client.tokens.close(9007199254740991n, 'sold');
    expect(writes[0]?.inputs.$token_id).toBe(9007199254740991);
  });

  it('refuses an id past MAX_SAFE_INTEGER rather than losing precision', async () => {
    const { client, writes } = await signing();

    await expect(client.tokens.close(9007199254740993n, 'sold')).rejects.toThrow(BranchError);
    expect(writes).toHaveLength(0);
  });
});
