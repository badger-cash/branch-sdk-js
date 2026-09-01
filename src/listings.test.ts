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
    expect(search?.params.$make).toBe('toyota');
    expect(search?.params.$model).toBe('corolla');
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

  it('adds one join per facet and none for absent ones', async () => {
    const { client, queries } = await connect();
    await client.listings.search({ make: 'toyota' });
    const withOne = queries.find((q) => q.sql.includes('ORDER BY'));
    expect((withOne?.sql.match(/JOIN metadata mk /g) ?? []).length).toBe(1);

    const { client: plain, queries: plainQueries } = await connect();
    await plain.listings.browse();
    const none = plainQueries.find((q) => q.sql.includes('ORDER BY'));
    expect(none?.sql).not.toContain('JOIN metadata mk ');
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
      contact_via: 'CNMI Central',
      listed_at: 1788224916,
    });

    const listing = await client.listings.get(42);
    expect(listing).toMatchObject({
      listingId: 42n,
      state: 'active',
      make: 'toyota',
      year: 2018,
      photos: ['a.jpg'],
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
