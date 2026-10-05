import { describe, expect, it } from 'vitest';

import { BranchClient } from './client.js';

import type { ActionInputs, KwilLike } from './client.js';

const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

interface Written {
  name: string;
  inputs: Record<string, unknown>;
  types: Record<string, unknown> | undefined;
}

interface Query {
  /** The action's NAME now. Kept as `sql` so the harness's shape did not churn. */
  sql: string;
  params: Record<string, unknown>;
}

/*
  THE CALL UNDER TEST, BY NAME. `queries[queries.length - 1]` used to be the only
  read a method made; a search is two now -- `search_tokens` then `token_fields` --
  so the last entry is the projection rather than the filter. Naming the action is
  also what makes these assertions legible: they are about what was ASKED of the
  chain, not about the text of a statement.
*/
const called = (queries: Query[], action: string): Record<string, unknown> =>
  queries.find((q) => q.sql === action)?.params ?? {};

/** What `current_type_version` answers with before any other read runs. */
const CLASS_ROW = [{ type_id: 1, type_version: 1, type_slug: 'automobile-listing', name: 'Cars' }];

const PHOTO_BASE = 'https://custodian.example';

/*
  A FLAT FIXTURE ROW, SPLIT INTO THE LONG FORMAT THE CHAIN RETURNS.

  The fixtures below stay flat -- one object per listing, a property per field --
  because that is what they have always been and rewriting fifty of them would be
  the change rather than the point. These two helpers take a flat fixture apart
  into the (record, field) rows `token_fields` and `get_token` really answer with,
  so the code under test sees the real shape and the tests stay readable.
*/
const IDENTITY = new Set([
  'id',
  'name',
  'created_at',
  'state',
  'listing_id',
  'title',
  'seller',
  'listed_at',
  'photo_base',
  'expires_at',
  // contact_via is not a field: it is the NAME of the custodian holding the
  // brokered `contact` field, and it rides on that field's row.
  'contact_via',
]);

const NUMERIC_FIELDS = new Set(['year', 'price', 'mileage']);
const BOOLEAN_FIELDS = new Set(['accepts_offers', 'accepts_trade']);
const JSON_FIELDS = new Set(['photos']);

function hitFrom(row: Record<string, unknown>): Record<string, unknown> {
  return {
    token_id: row.id ?? row.listing_id ?? 1,
    name: row.name ?? row.title ?? '',
    state: row.state ?? 'active',
    is_terminal: false,
    created_at: row.created_at ?? row.listed_at ?? 0,
    type_id: 1,
    type_version: 1,
  };
}

/*
  The fixtures predate the chain's own names in one place: they call the ticker
  `currency`, where the declared identifier is `price_currency`. Aliased here
  rather than renamed across fifty fixtures.
*/
const ALIAS: Record<string, string> = { currency: 'price_currency' };

function fieldRowsFrom(row: Record<string, unknown>): Array<Record<string, unknown>> {
  const id = row.id ?? row.listing_id ?? 1;
  const out: Array<Record<string, unknown>> = [];
  for (const [key, value] of Object.entries(row)) {
    if (IDENTITY.has(key)) continue;
    const identifier = ALIAS[key] ?? key;
    out.push({
      token_id: id,
      identifier,
      datatype: NUMERIC_FIELDS.has(identifier) ? 'number' : 'text',
      value_text:
        NUMERIC_FIELDS.has(identifier) ||
        BOOLEAN_FIELDS.has(identifier) ||
        JSON_FIELDS.has(identifier)
          ? null
          : value,
      value_number: NUMERIC_FIELDS.has(identifier) ? value : null,
      value_boolean: BOOLEAN_FIELDS.has(identifier) ? value : null,
      value_datetime: null,
      value_json: JSON_FIELDS.has(identifier) ? value : null,
      value_hmac: null,
      custodian_url: JSON_FIELDS.has(identifier) ? (row.photo_base ?? PHOTO_BASE) : null,
    });
  }
  if (row.expires_at !== undefined) {
    out.push({
      token_id: id,
      identifier: 'expires_at',
      datatype: 'datetime',
      value_text: null,
      value_number: null,
      value_boolean: null,
      value_datetime: row.expires_at,
      value_json: null,
      value_hmac: null,
      custodian_url: null,
    });
  }
  return out;
}

/** `get_token` repeats the identity on every row and adds one field. */
function detailRows(detail: Record<string, unknown>): Array<Record<string, unknown>> {
  const head = {
    token_id: detail.listing_id ?? detail.id ?? 1,
    type_slug: 'automobile-listing',
    name: detail.title ?? detail.name ?? '',
    state: detail.state ?? 'active',
    issuer_person: detail.seller ?? '',
    created_at: detail.listed_at ?? detail.created_at ?? 0,
  };
  const withContact = fieldRowsFrom(detail);
  if (detail.contact_via !== undefined) {
    withContact.push({
      token_id: head.token_id,
      identifier: 'contact',
      datatype: 'json',
      value_text: null,
      value_number: null,
      value_boolean: null,
      value_datetime: null,
      value_json: null,
      value_hmac: 'ab'.repeat(32),
      custodian_url: null,
    });
  }
  const rows = withContact.map((f) => ({
    ...head,
    identifier: f.identifier,
    datatype: f.datatype,
    is_brokered: false,
    custodian_name: detail.contact_via ?? null,
    // CARRIED THROUGH, because the real `get_token` returns it and has since
    // badger-cash/branch#122. The fixture dropped it and nothing noticed, because
    // the detail path used to resolve the photo base from a separate
    // `metadata_field_custodian_endpoint` call. It does not any more.
    custodian_url: f.custodian_url,
    value_text: f.value_text,
    value_number: f.value_number,
    value_boolean: f.value_boolean,
    value_datetime: f.value_datetime,
    value_json: f.value_json,
  }));
  // A record with no fields at all still has to answer, so the identity row goes
  // out on its own -- which is what the action does.
  return rows.length > 0
    ? rows
    : [
        {
          ...head,
          identifier: null,
          datatype: null,
          is_brokered: null,
          custodian_name: null,
          value_text: null,
          value_number: null,
          value_boolean: null,
          value_datetime: null,
          value_json: null,
        },
      ];
}

async function connect(
  rows: Record<string, unknown>[] = [],
  detail?: Record<string, unknown>
): Promise<{ client: BranchClient; queries: Query[]; writes: Written[] }> {
  const queries: Query[] = [];
  const writes: Written[] = [];

  /*
    EVERY READ IS A VIEW ACTION NOW, so the fake routes on the ACTION NAME rather
    than on the text of a SELECT. badger-cash/branch#119.

    That is a better contract to assert against, and the reason is the bug that
    prompted the change: these tests passed while the real read path was broken,
    because a mock that recognises `query.includes('token_classes')` keeps
    recognising it long after the chain has stopped having that table. An action
    name and its inputs are the thing the chain actually agrees to.

    The integration suite under tests/integration is what proves the shapes; this
    proves the CALL -- which action, with which inputs.
  */
  const kwil: KwilLike = {
    execute(body): Promise<{ data?: { tx_hash?: string } }> {
      writes.push({
        name: body.name,
        inputs: body.inputs[0] ?? {},
        types: body.types,
      });
      return Promise.resolve({ data: { tx_hash: '0xabc' } });
    },
    call(body): Promise<{ data?: { result?: unknown } }> {
      queries.push({ sql: body.name, params: body.inputs });
      switch (body.name) {
        case 'current_type_version':
          return Promise.resolve({ data: { result: CLASS_ROW } });
        case 'metadata_field_custodian_endpoint':
          // The fixture's own base when it names one, so a test can pin the URL a
          // photo resolves to. The detail path asks this action rather than
          // carrying photo_base on the row, because get_token gives the
          // declaration's custodian IDS and not its resolved address.
          return Promise.resolve({
            data: { result: [{ url: detail?.photo_base ?? rows[0]?.photo_base ?? PHOTO_BASE }] },
          });
        case 'get_token':
          return Promise.resolve({ data: { result: detail ? detailRows(detail) : [] } });
        case 'search_tokens':
        case 'my_tokens':
          return Promise.resolve({ data: { result: rows.map(hitFrom) } });
        case 'token_fields':
          return Promise.resolve({ data: { result: rows.flatMap(fieldRowsFrom) } });
        case 'type_fee_tiers':
          return Promise.resolve({ data: { result: rows } });
        default:
          return Promise.resolve({ data: { result: [] } });
      }
    },
    selectQuery<T extends object>(
      query: string,
      params?: Record<string, unknown>
    ): Promise<{ data?: T[] }> {
      queries.push({ sql: query, params: params ?? {} });
      return Promise.resolve({ data: rows as T[] });
    },
  };

  const client = await BranchClient.connect({
    provider: 'http://example.invalid',
    chainId: 'kwil-testnet',
    address: ADDRESS,
    signer: { signMessage: () => Promise.resolve('0x00') },
    kwil,
  });
  return { client, queries, writes };
}

const INPUT = {
  make: 'Toyota',
  model: 'Corolla',
  year: 2018,
  price: '12750',
  priceCurrency: 'credits',
  durationDays: 30,
  location: 'Susupe',
  contactHmacHex: 'a'.repeat(64),
  vin: '1HGBH41JXMN109186',
  mileage: '90000',
  description: 'Runs well.',
};

/** A key/value pair out of one of mint_token's six parallel array groups. */
function pair(inputs: Record<string, unknown>, keys: string, values: string): Map<string, unknown> {
  const k = inputs[keys] as string[];
  const v = inputs[values] as unknown[];
  expect(k.length).toBe(v.length);
  return new Map(k.map((identifier, i) => [identifier, v[i]]));
}

describe('create', () => {
  it('mints into the type rather than calling the retired create_listing', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);

    const write = writes[0];
    // branch#74 dropped create_listing. A directory is a token type now, and
    // the generic mint is handed one.
    expect(write?.name).toBe('mint_token');
    expect(write?.inputs.$type_id).toBe(1);
    expect(write?.inputs.$state_name).toBe('active');
    expect(write?.inputs.$duration_days).toBe(30);
  });

  it('composes the title, because the action no longer does', async () => {
    // create_listing built `year || ' ' || make || ' ' || model` in straight-line
    // code. mint_token cannot know that, so this package owns it -- and owns it
    // here rather than in the front end, so one directory has one convention.
    const { client, writes } = await connect();
    await client.listings.create(INPUT);
    expect(writes[0]?.inputs.$name).toBe('2018 Toyota Corolla');
  });

  it('does not fold anything, because the declaration still does', async () => {
    // The fold moved from create_listing's hand-written lower() to
    // metadata_schemas.folded, which mint_token honours
    // (41-explicit-mint-policy.sql:1245). Folding here as well would look
    // harmless and would put this package back in the business of knowing
    // which of a type's fields are searchable -- and would make the title
    // disagree with the metadata for any field it got wrong.
    const { client, writes } = await connect();
    await client.listings.create({ ...INPUT, make: 'Toyota', vin: '1HGBH41JXMN109186' });

    const text = pair(writes[0]?.inputs ?? {}, '$text_keys', '$text_values');
    expect(text.get('make')).toBe('Toyota');
    expect(text.get('vin')).toBe('1HGBH41JXMN109186');
    expect(text.get('location')).toBe('Susupe');
    expect(writes[0]?.inputs.$name).toBe('2018 Toyota Corolla');
  });

  it('is a non-fungible mint, so symbol and quantity are both null', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);
    // The action refuses either being set on a non-fungible type.
    expect(writes[0]?.inputs.$symbol).toBeNull();
    expect(writes[0]?.inputs.$quantity).toBeNull();
  });

  it('never supplies expires_at, which the chain computes from the term', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);
    // Supplying one alongside a paid term is refused outright, so that two
    // clients cannot disagree about what thirty days means.
    expect(writes[0]?.inputs.$datetime_keys).toEqual([]);
    expect(writes[0]?.inputs.$datetime_values).toEqual([]);
  });

  it('declares every array type, because an empty array infers to null[]', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);

    // kwil resolves an array's element type from value[0], so [] reads
    // undefined and resolves to null[] -- refused against a declared BOOL[] or
    // INT8[]. Nothing infers to NUMERIC either, empty or not.
    expect(Object.keys(writes[0]?.types ?? {}).sort()).toEqual([
      '$boolean_keys',
      '$boolean_values',
      '$brokered_hmacs',
      '$brokered_keys',
      '$datetime_keys',
      '$datetime_values',
      '$json_keys',
      '$json_values',
      '$number_keys',
      '$number_values',
      '$quantity',
      '$text_keys',
      '$text_values',
    ]);
  });

  it('keeps every key/value pair the same length', async () => {
    // unnest zips to the LONGER array and pads the shorter with NULLs, so a
    // mismatch writes a value against a null identifier rather than failing.
    const { client, writes } = await connect();
    await client.listings.create({ ...INPUT, bodyStyle: 'Pickup', acceptsOffers: true });

    const sent = writes[0]?.inputs ?? {};
    for (const [keys, values] of [
      ['$text_keys', '$text_values'],
      ['$number_keys', '$number_values'],
      ['$boolean_keys', '$boolean_values'],
      ['$datetime_keys', '$datetime_values'],
      ['$json_keys', '$json_values'],
      ['$brokered_keys', '$brokered_hmacs'],
    ]) {
      expect((sent[keys!] as unknown[]).length).toBe((sent[values!] as unknown[]).length);
    }
  });

  it('sends the mandatory fields in the pair matching their datatype', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);
    const sent = writes[0]?.inputs ?? {};

    const text = pair(sent, '$text_keys', '$text_values');
    expect(text.get('make')).toBe('Toyota');
    expect(text.get('model')).toBe('Corolla');
    expect(text.get('price_currency')).toBe('credits');
    expect(text.get('location')).toBe('Susupe');
    expect(text.get('vin')).toBe('1HGBH41JXMN109186');

    // Decimal strings, with the NUMERIC(38,10)[] type declared beside them.
    const numbers = pair(sent, '$number_keys', '$number_values');
    expect(numbers.get('price')).toBe('12750');
    expect(numbers.get('year')).toBe('2018');
    expect(numbers.get('mileage')).toBe('90000');
  });

  it('sends photos as a JSON array, since an identifier cannot repeat', async () => {
    const { client, writes } = await connect();
    await client.listings.create({ ...INPUT, photos: ['a.jpg', 'b.jpg'] });
    expect(pair(writes[0]?.inputs ?? {}, '$json_keys', '$json_values').get('photos')).toBe(
      '["a.jpg","b.jpg"]'
    );

    const { client: bare, writes: bareWrites } = await connect();
    await bare.listings.create(INPUT);
    expect(pair(bareWrites[0]?.inputs ?? {}, '$json_keys', '$json_values').get('photos')).toBe(
      '[]'
    );
  });

  it('passes the commitment through the brokered pair, never contact details', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);
    const sent = writes[0]?.inputs ?? {};
    // A brokered field carries an HMAC and a named custodian, never a value.
    expect(sent.$brokered_keys).toEqual(['contact']);
    expect(sent.$brokered_hmacs).toEqual(['a'.repeat(64)]);
    // And it is nowhere near the text pair.
    expect(sent.$text_keys).not.toContain('contact');
  });

  it('refuses a price that is not a decimal number', async () => {
    const { client } = await connect();
    await expect(client.listings.create({ ...INPUT, price: '12,750' })).rejects.toThrow(
      /decimal number/
    );
    await expect(client.listings.create({ ...INPUT, mileage: 'lots' })).rejects.toThrow(
      /decimal number/
    );
  });
});

describe('close', () => {
  it('names the terminal state, which is the type vocabulary now', async () => {
    const { client, writes } = await connect();
    await client.listings.close(42n, 'sold');
    await client.listings.close(43, 'withdrawn');
    // close_token resolves the target out of the type's own states and requires
    // it to be terminal, rather than validating a hardcoded pair itself.
    expect(writes[0]?.name).toBe('close_token');
    expect(writes[0]?.inputs).toEqual({ $token_id: 42, $state_name: 'sold' });
    expect(writes[1]?.inputs).toEqual({ $token_id: 43, $state_name: 'withdrawn' });
  });
});

describe('moderate', () => {
  it('takes a listing down to withdrawn, under the type office', async () => {
    const { client, writes } = await connect();
    await client.listings.moderate(42, 'counterfeit VIN');
    expect(writes[0]?.name).toBe('moderate_token');
    // The state is not a parameter of the public method: there is one terminal
    // state that means "taken down", and offering a choice would let a
    // moderator file a takedown as 'sold'.
    expect(writes[0]?.inputs).toEqual({
      $token_id: 42,
      $state_name: 'withdrawn',
      $reason: 'counterfeit VIN',
    });
  });
});

describe('setFee', () => {
  it('passes the type, which set_listing_fee used to resolve for itself', async () => {
    const { client, writes } = await connect();
    await client.listings.setFee(30, '2');
    expect(writes[0]?.name).toBe('set_type_fee');
    expect(writes[0]?.inputs).toEqual({ $type_id: 1, $duration_days: 30, $fee: '2' });
    // Nothing infers to NUMERIC.
    expect(writes[0]?.types).toEqual({ $fee: expect.anything() as unknown });
  });
});

describe('search', () => {
  it('pages on (created_at, id), not on the timestamp alone', async () => {
    const { client, queries } = await connect();
    await client.listings.search({
      after: { listedAt: new Date(1788224916 * 1000), listingId: 12n },
    });

    const search = called(queries, 'search_tokens');
    // created_at is @block_timestamp, so a whole block shares one value. The id
    // tiebreaker is what stops a page repeating or skipping rows, and BOTH halves
    // of the cursor have to reach the action for it to apply one.
    expect(search.$after_created_at).toBe(1788224916);
    expect(search.$after_id).toBe(12);
  });

  it('folds make and model so the equality stays on the index', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ make: 'Toyota', model: ' Corolla ' });

    const search = called(queries, 'search_tokens');
    /*
      Folded HERE rather than lower()ed on the chain: kwil has no expression
      indexes, so lower(value_text) would scan every metadata row. The action
      compares against what mint_token stored, and mint_token lowercases a field
      its declaration marks folded -- so a buyer's 'Toyota' has to arrive folded.

      ' Corolla ' also arrives trimmed, which is the other half: a facet is a value
      a seller chose, and whitespace is not part of it.
    */
    expect(search.$text_values).toEqual(['toyota', 'corolla']);
  });

  it('inlines numeric bounds with an explicit cast', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ yearFrom: 2015, yearTo: 2020, maxPrice: '20000' });

    const search = called(queries, 'search_tokens');
    /*
      THE BOUNDS TRAVEL AS DECIMAL STRINGS AND THE ACTION CASTS THEM.

      They used to be inlined into the SQL with an explicit `::NUMERIC(38,10)`,
      because value_number is NUMERIC(38,10), a bare 2015 is int8, there is no
      implicit promotion, and selectQuery cannot declare a parameter type.

      The action can, and still should not: nothing infers to NUMERIC, so an
      undeclared [2015] arrives as int8[] and is refused -- and a DECLARED array
      whose elements are all NULL arrives as numeric(0,0)[] and is refused too,
      which is exactly the array `yearFrom` with no `yearTo` produces. Text has
      neither problem. Verified against a running node, both ways.

      Paired by position: year carries both ends, price only an upper one.
    */
    expect(search.$number_keys).toEqual(['year', 'price']);
    expect(search.$number_mins).toEqual(['2015', null]);
    expect(search.$number_maxs).toEqual(['2020', '20000']);
  });

  /**
   * The numeric bounds are the only values written into the statement rather
   * than bound. That is safe because of the whitelist, not despite it.
   */
  it('refuses a bound that is not a decimal number', async () => {
    const { client } = await connect();
    for (const evil of ['2015; DROP TABLE tokens', "2015' OR '1'='1", '2015 OR 1=1', '']) {
      await expect(client.listings.search({ maxPrice: evil })).rejects.toThrow(/decimal number/);
    }
  });

  it('adds one facet join however many facets, and none for absent ones', async () => {
    // Rewritten from "one join per facet", which is the contract this
    // deliberately replaced: eight facets would have taken a filtered browse
    // past twenty joins.
    const { client, queries } = await connect();
    await client.listings.search({ make: 'toyota' });
    const withOne = called(queries, 'search_tokens');
    expect(withOne.$text_keys).toEqual(['make']);

    const { client: plain, queries: plainQueries } = await connect();
    await plain.listings.browse();
    const none = called(plainQueries, 'search_tokens');
    expect(none.$text_keys).toBeNull();
  });

  it('hides listings whose paid term has run out', async () => {
    const { client } = await connect();
    await client.listings.browse();
    // A chain has no timers, so the state cache lags the deadline. The filter can
    // hide a listing the sweep has not reached, never show one it has.
    const browse = await client.listings.browse();
    /*
      THE DEADLINE IS FILTERED IN THIS CLIENT NOW, not on the chain, and that is a
      real move rather than a translation. `browse_listings` compared expires_at
      against @block_timestamp; `search_tokens` excludes terminal STATES and knows
      nothing about deadlines, because a deadline is one directory's declared field
      and not a property of a token. A lapsed record stays `active` until the
      permissionless sweep moves it, so a grid that showed it would be advertising
      a term that has run out.
    */
    expect(browse).toHaveLength(0);
  });

  it('clamps the limit', async () => {
    const { client, queries } = await connect();
    await client.listings.browse({ limit: 5000 });
    expect(called(queries, 'search_tokens').$limit).toBe(200);
    await expect(client.listings.browse({ limit: 0 })).rejects.toThrow(/positive integer/);
  });
});

describe('mine', () => {
  it('resolves the caller on the canonical address, in every state', async () => {
    const { client, queries } = await connect();
    await client.listings.mine();

    const mine = called(queries, 'my_tokens');
    /*
      THE ACTION RESOLVES THE CALLER. This used to bind lower(address) into a SELECT
      and carry the confirmed/revoked predicates itself -- which made the client the
      owner of `WHERE address = lower(@caller)`, the most repeated trap in this
      schema. `my_tokens` does it from @caller, so no address crosses the wire and
      there is nothing here to get wrong.
    */
    expect(mine.$type_slug).toBe('automobile-listing');
    // Not filtered to active: a seller needs to see what they withdrew or sold.
  });

  /*
    The expiry has to be SELECTED, not merely joined.

    That distinction is the whole of island-nook#95: `search` already joined
    expires_at into its WHERE to drop expired listings, so the column was in the
    query and absent from the result, and no UI could show a seller the term
    they had paid for. A test that only checked for the identifier would have
    passed against that bug.
  */
  it('selects the expiry rather than only filtering on it', async () => {
    const { client, queries } = await connect([
      { id: 1, name: 'A car', created_at: 1757000000, state: 'active', expires_at: 1790000000 },
    ]);
    const rows = await client.listings.mine();

    /*
      THE EXPIRY IS FETCHED, NOT MERELY FILTERED ON, which is the whole of
      island-nook#95: `search` joined expires_at into its WHERE to drop expired
      listings, so the column was in the query and absent from the result and no UI
      could show a seller the term they had paid for.

      It comes from `token_fields` now rather than from a column on the identity
      call -- a deadline is one directory's declared field, so it lives with the
      fields. Asserted as a VALUE reaching the caller, because an assertion that
      only checked the identifier was in the request is what passed against the bug.
    */
    expect(queries.map((q) => q.sql)).toContain('token_fields');
    expect(rows[0]?.expiresAt).toEqual(new Date(1790000000 * 1000));
  });

  it('maps the expiry, and leaves it null when a listing has none', async () => {
    const ends = 1792000000;
    const { client } = await connect([
      { id: 1, name: 'With a term', created_at: 1789000000, state: 'active', expires_at: ends },
      { id: 2, name: 'Without one', created_at: 1789000000, state: 'active', expires_at: null },
    ]);

    const mine = await client.listings.mine();
    expect(mine).toHaveLength(2);
    // Optional chaining because noUncheckedIndexedAccess is on, and it costs
    // nothing here: undefined fails both assertions as loudly as a wrong value.
    expect(mine[0]?.expiresAt).toEqual(new Date(ends * 1000));
    // Null is an answer: a listing published without a duration never lapses,
    // and inventing a date here would tell a seller theirs had ended.
    expect(mine[1]?.expiresAt).toBeNull();
  });
});

describe('get', () => {
  it('is null when nothing has that id', async () => {
    const { client } = await connect();
    await expect(client.listings.get(999n)).resolves.toBeNull();
  });

  it('maps a listing, price included, without a float', async () => {
    const { client } = await connect([], {
      listing_id: 42,
      title: 'Toyota Corolla',
      state: 'active',
      seller: 'Ada',
      make: 'toyota',
      model: 'corolla',
      year: 2018,
      price: '12750',
      currency: 'credits',
      location: 'Susupe',
      mileage: 90000,
      vin: '1hgbh41jxmn109186',
      description: 'Runs well.',
      photos: '["a.jpg"]',
      photo_base: 'https://custodian.test',
      contact_via: 'CNMI Central',
      listed_at: 1788224916,
    });

    const listing = await client.listings.get(42);
    expect(listing).toMatchObject({
      listingId: 42n,
      state: 'active',
      make: 'toyota',
      year: 2018,
      // Composed against the custodian address that came back with the row,
      // so a caller never holds a key it cannot fetch.
      photos: ['https://custodian.test/objects/a.jpg'],
      contactVia: 'CNMI Central',
    });
    // '12750' at scale 10 is 127500000000000 units, not 12750.
    expect(listing?.price.units).toBe(127500000000000n);
    expect(listing?.price.decimals).toBe(10);
  });

  it('survives photos that are not usable JSON', async () => {
    const { client } = await connect([], {
      listing_id: 1,
      title: 't',
      state: 'active',
      seller: 's',
      make: 'm',
      model: 'm',
      year: 2000,
      price: '1',
      currency: 'credits',
      location: 'l',
      mileage: 1,
      vin: 'v',
      description: 'd',
      photos: 'not json',
      contact_via: 'c',
      listed_at: 1,
    });
    await expect(client.listings.get(1)).resolves.toMatchObject({ photos: [] });
  });
});

describe('action inputs', () => {
  it('never sends a bigint, which kwil cannot encode', async () => {
    const { client, writes } = await connect();
    await client.listings.close(42n, 'sold');
    const inputs = writes[0]?.inputs as ActionInputs;
    expect(typeof inputs.$token_id).toBe('number');
  });

  it('refuses an id too large to bind', async () => {
    const { client } = await connect();
    await expect(client.listings.close(2n ** 60n, 'sold')).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });
});

/*
  These cover the parsing and the arithmetic, which are this package's own and
  are worth pinning. They do NOT cover whether the SELECT is one the node will
  accept -- a stub answers whatever it is asked, so a green test here would say
  nothing about the query being valid. That half is verified against a running
  node, which is the lesson W2 paid for.
*/
describe('fees', () => {
  // `type_fee_tiers` returns (identifier, fee). The old SELECT returned the raw
  // metadata column, value_number, which is the same number under another name.
  const rate = (identifier: string, value: string) => ({
    identifier,
    fee: value,
  });

  it('reads the tiers the chain configures, cheapest first', async () => {
    const { client } = await connect([
      rate('fee_180d', '3.0000000000'),
      rate('fee_30d', '1.0000000000'),
    ]);
    const tiers = await client.listings.fees();
    expect(tiers.map((t) => t.durationDays)).toEqual([30, 180]);
    expect(tiers[0]?.fee).toEqual({ units: 1n, decimals: 0 });
    expect(tiers[1]?.fee).toEqual({ units: 3n, decimals: 0 });
  });

  it('discovers a tier nobody wrote into this package', async () => {
    const { client } = await connect([rate('fee_7d', '1.0000000000')]);
    expect((await client.listings.fees())[0]?.durationDays).toBe(7);
  });

  it('ignores type metadata that is not a rate', async () => {
    const { client } = await connect([
      rate('fee_30d', '1.0000000000'),
      // A wildcard LIKE would have taken this one: `_` matches any character.
      rate('feeXd', '99.0000000000'),
      rate('description', '0.0000000000'),
    ]);
    const tiers = await client.listings.fees();
    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.durationDays).toBe(30);
  });

  it('rounds a fractional rate the way the chain charges it', async () => {
    // listing_fee casts to NUMERIC(78,0), and a Postgres numeric cast rounds
    // rather than truncating. Flooring here would quote 1 and debit 2.
    const { client } = await connect([
      rate('fee_1d', '1.6000000000'),
      rate('fee_2d', '1.5000000000'),
      rate('fee_3d', '1.4999999999'),
    ]);
    const tiers = await client.listings.fees();
    expect(tiers.map((t) => t.fee.units)).toEqual([2n, 2n, 1n]);
  });

  it('gives a fee on the ledger scale, not the column scale', async () => {
    // The trap this exists to close: the rate column is NUMERIC(38,10) and a
    // balance is NUMERIC(78,0). Comparing raw units across the two would find
    // 1 credit affordable against a balance of 0.
    const { client } = await connect([rate('fee_30d', '1.0000000000')]);
    const [tier] = await client.listings.fees();
    expect(tier?.fee.decimals).toBe(0);
    expect(tier?.fee.units).toBe(1n);
  });

  it('returns nothing when no duration is priced', async () => {
    const { client } = await connect([]);
    expect(await client.listings.fees()).toEqual([]);
  });
});

/*
  The optional descriptors. These pin the mapping and the null handling; whether
  twenty LEFT JOINs is a query the node accepts is verified against a running
  node, because a stub answers whatever it is asked.
*/
describe('optional descriptors', () => {
  it('omits the key entirely for anything the seller left alone', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);

    const sent = writes[0]?.inputs ?? {};
    // NOT an empty string, and under mint_token not a null either: a key that
    // is present writes a row, so an unanswered field has to be absent from
    // the pair altogether.
    expect(sent.$text_keys).not.toContain('body_style');
    expect(sent.$text_keys).not.toContain('title_status');
    expect(sent.$boolean_keys).toEqual([]);
    expect(sent.$boolean_values).toEqual([]);
  });

  it('sends false as false, not as absent', async () => {
    const { client, writes } = await connect();
    await client.listings.create({ ...INPUT, acceptsOffers: true, acceptsTrade: false });

    const flags = pair(writes[0]?.inputs ?? {}, '$boolean_keys', '$boolean_values');
    expect(flags.get('accepts_offers')).toBe(true);
    // The whole point: a seller who declined has answered, and that must not
    // collapse into "never asked", which here means dropping the key.
    expect(flags.get('accepts_trade')).toBe(false);
  });

  it('passes the descriptors through unfolded, because the chain folds them', async () => {
    const { client, writes } = await connect();
    await client.listings.create({ ...INPUT, bodyStyle: 'Pickup', fuelType: 'Diesel' });

    const text = pair(writes[0]?.inputs ?? {}, '$text_keys', '$text_values');
    expect(text.get('body_style')).toBe('Pickup');
    expect(text.get('fuel_type')).toBe('Diesel');
  });

  it('reads a summary flag back, and distinguishes false from never asked', async () => {
    const summary = (over: Record<string, unknown>) => ({
      id: 1,
      name: '2021 Toyota Hilux',
      created_at: 1757000000,
      make: 'toyota',
      model: 'hilux',
      year: '2021',
      price: '18000',
      currency: 'credits',
      location: 'Garapan',
      accepts_offers: null,
      accepts_trade: null,
      ...over,
    });

    const asked = await connect([summary({ accepts_offers: true, accepts_trade: false })]);
    const [row] = await asked.client.listings.search();
    expect(row?.acceptsOffers).toBe(true);
    expect(row?.acceptsTrade).toBe(false);

    const never = await connect([summary({})]);
    const [quiet] = await never.client.listings.search();
    expect(quiet?.acceptsOffers).toBeNull();
    expect(quiet?.acceptsTrade).toBeNull();
  });

  it('treats an empty descriptor as absent rather than as an answer', async () => {
    // The action never writes one -- it skips an empty field -- so an empty
    // string here came from something that bypassed the action, and '' is not
    // a body style a seller chose.
    const { client } = await connect([], {
      listing_id: 1,
      title: '2021 Toyota Hilux',
      state: 'active',
      seller: 'Ada',
      make: 'toyota',
      model: 'hilux',
      year: '2021',
      price: '18000',
      currency: 'credits',
      location: 'Garapan',
      mileage: '42000',
      vin: 'x',
      description: 'd',
      photos: '[]',
      contact_via: 'CNMI Central',
      listed_at: 1757000000,
      body_style: '',
      transmission: null,
      fuel_type: null,
      exterior_color: null,
      condition: null,
      title_status: null,
      accepts_offers: null,
      accepts_trade: null,
    });
    const listing = await client.listings.get(1n);
    expect(listing?.bodyStyle).toBeNull();
    expect(listing?.titleStatus).toBeNull();
  });
});

describe('photos on the browse summary', () => {
  const summary = (over: Record<string, unknown>) => ({
    id: 1,
    name: '2021 Toyota Hilux',
    created_at: 1757000000,
    make: 'toyota',
    model: 'hilux',
    year: '2021',
    price: '18000',
    currency: 'credits',
    location: 'Garapan',
    accepts_offers: null,
    accepts_trade: null,
    photos: null,
    ...over,
  });

  it('carries the photo URLs a card needs', async () => {
    // Left off the summary at first, on the reasoning that browse should stay
    // cheap. The result was a grid of placeholder icons -- the one thing a car
    // marketplace cannot ship, because the picture IS the listing on a card.
    const { client } = await connect([
      summary({ photos: '["https://objects.test/a.jpg","https://objects.test/b.jpg"]' }),
    ]);
    const [row] = await client.listings.search();
    expect(row?.photos).toEqual(['https://objects.test/a.jpg', 'https://objects.test/b.jpg']);
  });

  it('gives an empty array to a listing with none, not null', async () => {
    // Common and permanent: photos are optional, and every listing published
    // before the upload pipeline existed has none. A card still needs to render.
    const { client } = await connect([summary({})]);
    const [row] = await client.listings.search();
    expect(row?.photos).toEqual([]);
  });

  it('survives a photos row that is not an array', async () => {
    // value_json is TEXT and nothing on the chain validates its shape, so a
    // client that trusted it would throw on the browse page rather than on the
    // one listing that was malformed.
    const { client } = await connect([summary({ photos: '{"not":"an array"}' })]);
    const [row] = await client.listings.search();
    expect(row?.photos).toEqual([]);
  });
});

describe('facet filters', () => {
  it('collapses every text facet into a single join', async () => {
    const { client, queries } = await connect();
    await client.listings.search({
      make: 'Toyota',
      bodyStyle: 'SUV',
      transmission: 'Automatic',
      fuelType: 'Diesel',
      exteriorColor: 'White',
      condition: 'Used',
      titleStatus: 'Clean',
    });

    /*
       SEVEN FACETS IN ONE PAIR OF ARRAYS. The old shape was a join per predicate
       and drew its own line at "three or four"; the action takes identifiers and
       values as two parallel arrays, so a seventh facet costs one more element.
     */
    const params = called(queries, 'search_tokens');
    // All seven arrive as one pair of arrays. There is no join to count any more --
    // the shape this assertion used to guard is now the action's, and what the
    // client owes is that every facet was sent, once, paired with its value.
    expect(params.$text_keys).toEqual([
      'make',
      'body_style',
      'transmission',
      'fuel_type',
      'exterior_color',
      'condition',
      'title_status',
    ]);
    expect(params.$text_values).toEqual([
      'toyota',
      'suv',
      'automatic',
      'diesel',
      'white',
      'used',
      'clean',
    ]);
  });

  it('folds every facet value, because the chain folds on write', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ make: 'Toyota', bodyStyle: 'SUV' });

    const params = called(queries, 'search_tokens');
    expect(params.$text_values).toContain('toyota');
    expect(params.$text_values).toContain('suv');
    // Two pairs requested, and the action ANDs them.
    expect(params.$text_keys).toEqual(['make', 'body_style']);
  });

  it('requires every facet, not any of them', async () => {
    // The OR chain gathers candidate rows; the HAVING is what makes it AND.
    // Without the count, asking for a Toyota SUV would return every Toyota and
    // every SUV.
    const { client, queries } = await connect();
    await client.listings.search({ make: 'Toyota', bodyStyle: 'SUV', condition: 'Used' });
    expect(called(queries, 'search_tokens').$text_keys).toEqual([
      'make',
      'body_style',
      'condition',
    ]);
  });

  it('ignores a facet that is blank rather than matching on empty', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ make: 'Toyota', bodyStyle: '   ' });
    // A blank facet is dropped before it is sent, not matched on empty.
    expect(called(queries, 'search_tokens').$text_keys).toEqual(['make']);
  });

  it('adds no facet join at all when none is asked for', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ limit: 10 });
    // NULL, not an empty array: the action reads a NULL array as "no facets", and
    // an empty one is what the CLI cannot even encode.
    const params = called(queries, 'search_tokens');
    expect(params.$text_keys).toBeNull();
    expect(params.$text_values).toBeNull();
  });

  it('filters the flags only on true', async () => {
    /*
      Matched on the FILTER predicate, not the identifier. `accepts_offers`
      appears in every browse query regardless, because the projection selects
      it for the card — asserting on the bare name was this test's first
      mistake, and it passed for the wrong reason.
    */
    const asked = await connect();
    await asked.client.listings.search({ acceptsOffers: true });
    expect(called(asked.queries, 'search_tokens').$boolean_keys).toEqual(['accepts_offers']);

    // false must not narrow: it would exclude every listing published before
    // the field existed, which is null rather than false.
    const not = await connect();
    await not.client.listings.search({ acceptsOffers: false });
    expect(called(not.queries, 'search_tokens').$boolean_keys).toBeNull();
  });

  it('keeps the keyset cursor alongside a facet', async () => {
    // The thing a GROUP BY rewrite is most likely to break. Paging has to stay
    // correct under a filter or "Load more" repeats or skips listings.
    const { client, queries } = await connect();
    await client.listings.search({
      make: 'Toyota',
      after: { listedAt: new Date(1757000000 * 1000), listingId: 42n },
    });

    // A facet and a cursor travel together; neither displaces the other.
    const params = called(queries, 'search_tokens');
    expect(params.$text_keys).toEqual(['make']);
    expect(params.$after_created_at).toBe(1757000000);
    expect(params.$after_id).toBe(42);
  });
});
