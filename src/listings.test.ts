import { describe, expect, it } from 'vitest';

import { BranchClient } from './client.js';

import type { ActionInputs, KwilLike } from './client.js';

const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const LOWER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

interface Written {
  name: string;
  inputs: Record<string, unknown>;
  types: Record<string, unknown> | undefined;
}

interface Query {
  sql: string;
  params: Record<string, unknown>;
}

/** Rows the class/state lookup needs before any other query runs. */
const CLASS_ROW = [{ class_id: 1, state_id: 2 }];

async function connect(
  rows: Record<string, unknown>[] = [],
  detail?: Record<string, unknown>
): Promise<{ client: BranchClient; queries: Query[]; writes: Written[] }> {
  const queries: Query[] = [];
  const writes: Written[] = [];

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
      if (body.name === 'get_listing') {
        return Promise.resolve({ data: { result: detail ? [detail] : [] } });
      }
      return Promise.resolve({ data: { result: [] } });
    },
    selectQuery<T extends object>(
      query: string,
      params?: Record<string, unknown>
    ): Promise<{ data?: T[] }> {
      queries.push({ sql: query, params: params ?? {} });
      if (query.includes('token_classes')) return Promise.resolve({ data: CLASS_ROW as T[] });
      // `get` is a plain SELECT now rather than the get_listing view action, so
      // that a listing can be opened without signing in. It is recognised by
      // the join no other read makes.
      if (query.includes('token_class_states st')) {
        return Promise.resolve({ data: (detail ? [detail] : []) as T[] });
      }
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

describe('create', () => {
  it('declares the NUMERIC parameters, because nothing infers to NUMERIC', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);

    const write = writes[0];
    expect(write?.name).toBe('create_listing');
    // A string infers text and a number infers int8; the action refuses both.
    expect(write?.types).toEqual({
      $price: expect.anything() as unknown,
      $mileage: expect.anything() as unknown,
    });
  });

  it('sends photos as a JSON array, since an identifier cannot repeat', async () => {
    const { client, writes } = await connect();
    await client.listings.create({ ...INPUT, photos: ['a.jpg', 'b.jpg'] });
    expect(writes[0]?.inputs.$photos_json).toBe('["a.jpg","b.jpg"]');

    const { client: bare, writes: bareWrites } = await connect();
    await bare.listings.create(INPUT);
    expect(bareWrites[0]?.inputs.$photos_json).toBe('[]');
  });

  it('passes the commitment through, never contact details', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);
    expect(writes[0]?.inputs.$contact_hmac_hex).toBe('a'.repeat(64));
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
  it('sends the outcome', async () => {
    const { client, writes } = await connect();
    await client.listings.close(42n, 'sold');
    await client.listings.close(43, 'withdrawn');
    expect(writes[0]?.inputs).toEqual({ $token_id: 42, $outcome: 'sold' });
    expect(writes[1]?.inputs).toEqual({ $token_id: 43, $outcome: 'withdrawn' });
  });
});

describe('search', () => {
  it('pages on (created_at, id), not on the timestamp alone', async () => {
    const { client, queries } = await connect();
    await client.listings.search({
      after: { listedAt: new Date(1788224916 * 1000), listingId: 12n },
    });

    const search = queries.find((q) => q.sql.includes('ORDER BY'));
    // created_at is @block_timestamp, so a whole block shares one value. The
    // id tiebreaker is what stops a page repeating or skipping rows.
    expect(search?.sql).toContain('t.created_at < $after_at OR (t.created_at = $after_at');
    expect(search?.params.$after_at).toBe(1788224916);
    expect(search?.params.$after_id).toBe(12);
    expect(search?.sql).toContain('ORDER BY t.created_at DESC, t.id DESC');
  });

  it('folds make and model so the equality stays on the index', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ make: 'Toyota', model: ' Corolla ' });

    const search = queries.find((q) => q.sql.includes('ORDER BY'));
    // Folded here rather than lower()ed in SQL: kwil has no expression
    // indexes, so lower(value_text) would scan every metadata row.
    //
    // Bound as $f0/$f1 rather than $make/$model since the facets collapsed
    // into one join — the values are what matter, not which slot they took.
    expect(Object.values(search?.params ?? {})).toContain('toyota');
    expect(Object.values(search?.params ?? {})).toContain('corolla');
    expect(search?.sql).not.toContain('lower(');
  });

  it('inlines numeric bounds with an explicit cast', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ yearFrom: 2015, yearTo: 2020, maxPrice: '20000' });

    const search = queries.find((q) => q.sql.includes('ORDER BY'));
    // value_number is NUMERIC(38,10) and a bare 2015 is int8. There is no
    // implicit promotion, and selectQuery cannot declare a parameter type.
    expect(search?.sql).toContain('2015::NUMERIC(38,10)');
    expect(search?.sql).toContain('2020::NUMERIC(38,10)');
    expect(search?.sql).toContain('20000::NUMERIC(38,10)');
  });

  /**
   * The numeric bounds are the only values written into the statement rather
   * than bound. That is safe because of the whitelist, not despite it.
   */
  it('refuses anything but digits in an inlined bound', async () => {
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
    const withOne = queries.find((q) => q.sql.includes('ORDER BY'));
    expect((withOne?.sql.match(/HAVING count\(DISTINCT identifier\)/g) ?? []).length).toBe(1);

    const { client: plain, queries: plainQueries } = await connect();
    await plain.listings.browse();
    const none = plainQueries.find((q) => q.sql.includes('ORDER BY'));
    expect(none?.sql).not.toContain('HAVING');
  });

  it('hides listings whose paid term has run out', async () => {
    const { client, queries } = await connect();
    await client.listings.browse();
    const browse = queries.find((q) => q.sql.includes('ORDER BY'));
    // A chain has no timers, so the state cache lags the deadline. The filter
    // can hide a listing the sweep has not reached, never show one it has.
    expect(browse?.sql).toContain('mev.value_datetime IS NULL OR mev.value_datetime > $now');
  });

  it('clamps the limit', async () => {
    const { client, queries } = await connect();
    await client.listings.browse({ limit: 5000 });
    expect(queries.find((q) => q.sql.includes('ORDER BY'))?.params.$take).toBe(200);
    await expect(client.listings.browse({ limit: 0 })).rejects.toThrow(/positive integer/);
  });
});

describe('mine', () => {
  it('resolves the caller on the canonical address, in every state', async () => {
    const { client, queries } = await connect();
    await client.listings.mine();

    // Not `token_class_states` -- the class lookup mentions that too.
    const mine = queries.find((q) => q.sql.includes('person_keys'));
    expect(mine?.params.$address).toBe(LOWER);
    // Not filtered to active: a seller needs to see what they withdrew or sold.
    expect(mine?.sql).not.toContain('current_state_id = $active');
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
  const rate = (identifier: string, value: string) => ({
    identifier,
    value_number: value,
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

  it('ignores class metadata that is not a rate', async () => {
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
  it('sends null for anything the seller left alone', async () => {
    const { client, writes } = await connect();
    await client.listings.create(INPUT);

    const sent = writes[0]?.inputs ?? {};
    // NOT an empty string. The action treats '' and NULL alike, but sending
    // null is what says "unanswered" at the boundary rather than relying on
    // that equivalence holding.
    expect(sent.$body_style).toBeNull();
    expect(sent.$title_status).toBeNull();
    expect(sent.$accepts_offers).toBeNull();
    expect(sent.$accepts_trade).toBeNull();
  });

  it('sends false as false, not as absent', async () => {
    const { client, writes } = await connect();
    await client.listings.create({ ...INPUT, acceptsOffers: true, acceptsTrade: false });

    const sent = writes[0]?.inputs ?? {};
    expect(sent.$accepts_offers).toBe(true);
    // The whole point: a seller who declined has answered, and `?? null` must
    // not collapse that into "never asked".
    expect(sent.$accepts_trade).toBe(false);
  });

  it('passes the descriptors through unfolded, because the chain folds them', async () => {
    const { client, writes } = await connect();
    await client.listings.create({ ...INPUT, bodyStyle: 'Pickup', fuelType: 'Diesel' });

    const sent = writes[0]?.inputs ?? {};
    expect(sent.$body_style).toBe('Pickup');
    expect(sent.$fuel_type).toBe('Diesel');
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

    const sql = queries[queries.length - 1]?.sql ?? '';
    // Seven facets. One join, not seven -- which is the whole point: the old
    // shape drew its own line at "three or four".
    //
    // INNER joins only. The projection carries a dozen LEFT JOIN metadata to
    // build the card, and counting those was this assertion's first mistake:
    // it reported ten filter joins where there are none.
    const filterJoins = (sql.match(/(?<!LEFT )JOIN metadata/g) ?? []).length;
    expect(filterJoins).toBe(0);
    expect((sql.match(/HAVING count\(DISTINCT identifier\)/g) ?? []).length).toBe(1);
  });

  it('folds every facet value, because the chain folds on write', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ make: 'Toyota', bodyStyle: 'SUV' });

    const params = queries[queries.length - 1]?.params ?? {};
    expect(Object.values(params)).toContain('toyota');
    expect(Object.values(params)).toContain('suv');
    // Two pairs requested, so a listing must match both.
    expect(params.$facets).toBe(2);
  });

  it('requires every facet, not any of them', async () => {
    // The OR chain gathers candidate rows; the HAVING is what makes it AND.
    // Without the count, asking for a Toyota SUV would return every Toyota and
    // every SUV.
    const { client, queries } = await connect();
    await client.listings.search({ make: 'Toyota', bodyStyle: 'SUV', condition: 'Used' });
    expect(queries[queries.length - 1]?.params.$facets).toBe(3);
  });

  it('ignores a facet that is blank rather than matching on empty', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ make: 'Toyota', bodyStyle: '   ' });
    expect(queries[queries.length - 1]?.params.$facets).toBe(1);
  });

  it('adds no facet join at all when none is asked for', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ limit: 10 });
    const sql = queries[queries.length - 1]?.sql ?? '';
    expect(sql).not.toContain('HAVING');
    expect(sql).not.toContain('$facets');
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
    expect(asked.queries[asked.queries.length - 1]?.sql).toContain('fao.value_boolean = true');

    // false must not narrow: it would exclude every listing published before
    // the field existed, which is null rather than false.
    const not = await connect();
    await not.client.listings.search({ acceptsOffers: false });
    expect(not.queries[not.queries.length - 1]?.sql).not.toContain('fao.value_boolean = true');
  });

  it('keeps the keyset cursor alongside a facet', async () => {
    // The thing a GROUP BY rewrite is most likely to break. Paging has to stay
    // correct under a filter or "Load more" repeats or skips listings.
    const { client, queries } = await connect();
    await client.listings.search({
      make: 'Toyota',
      after: { listedAt: new Date(1757000000 * 1000), listingId: 42n },
    });

    const sql = queries[queries.length - 1]?.sql ?? '';
    expect(sql).toContain('HAVING count(DISTINCT identifier)');
    expect(sql).toContain('t.created_at < $after_at');
    expect(sql).toContain('ORDER BY t.created_at DESC, t.id DESC');
  });
});
