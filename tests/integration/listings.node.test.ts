import { beforeAll, describe, expect, it } from 'vitest';

import {
  ActionFailedError,
  BranchClient,
  fetchChainId,
  formatAmount,
  numeric,
} from '../../src/index.js';

import { OPERATOR_KEY, localWallet } from './local-wallet.js';

/**
 * The listings client against a live node.
 *
 * The read paths here are hand-written SQL that no unit test can validate:
 * the double only records the string. Whether kwil's planner accepts the
 * joins, the cursor comparison and the NUMERIC casts is a question only a
 * node answers, and the spec file records that both of its own gotchas were
 * "found by running this query rather than by parsing it".
 */

const PROVIDER = process.env.BRANCH_PROVIDER ?? 'http://127.0.0.1:8484';
const EXPLICIT = process.env.BRANCH_PROVIDER !== undefined;
const AMOUNT_IS_NUMERIC = { $amount: numeric(78, 0) };

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

async function connect(privateKey?: string): Promise<BranchClient> {
  const { address, signer } = await localWallet(privateKey);
  return await BranchClient.connect({ provider: PROVIDER, chainId, address, signer });
}

/** A registered seller with enough credits to pay a listing fee. */
async function seller(name: string): Promise<BranchClient> {
  const client = await connect();
  await client.identity.register(name);
  const operator = await connect(OPERATOR_KEY);
  await operator.write(
    'issue_credits',
    { $to_address: client.address, $amount: '500', $reference: 'listing-tests' },
    AMOUNT_IS_NUMERIC
  );
  return client;
}

/** A VIN nobody else in this run will use. */
function uniqueVin(): string {
  const suffix = Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0');
  return `1HGBH41JX${suffix}`;
}

interface ListingFixture {
  make: string;
  model: string;
  year: number;
  price: string;
  priceCurrency: string;
  durationDays: number;
  location: string;
  contactHmacHex: string;
  vin: string;
  mileage: string;
  description: string;
  photos: string[];
}

function listingInput(over: Partial<ListingFixture> = {}): ListingFixture {
  return {
    make: 'Toyota',
    model: 'Corolla',
    year: 2018,
    price: '12750',
    priceCurrency: 'credits',
    durationDays: 30,
    location: 'Susupe',
    contactHmacHex: 'a'.repeat(64),
    vin: uniqueVin(),
    mileage: '90000',
    description: 'Runs well.',
    photos: ['https://example.invalid/a.jpg'],
    ...over,
  };
}

describe('listings client', () => {
  it('publishes a listing and reads it back in full', async () => {
    if (!requireNode()) return;
    const user = await seller('Listing Seller');
    const input = listingInput();

    await user.listings.create(input);

    const mine = await user.listings.mine();
    expect(mine.length).toBeGreaterThanOrEqual(1);
    const id = mine[0]?.listingId;
    expect(id).toBeDefined();

    const listing = await user.listings.get(id!);
    expect(listing).toMatchObject({
      state: 'active',
      // Folded on write, so a search stays a bare equality on the index.
      make: 'toyota',
      model: 'corolla',
      year: 2018,
      location: 'Susupe',
      contactVia: 'CNMI Central',
    });
    // NUMERIC(38,10) survives the round trip exactly.
    expect(formatAmount(listing!.price, { trim: true })).toBe('12750');
    expect(listing?.photos).toEqual(['https://example.invalid/a.jpg']);
    // The VIN is folded too.
    expect(listing?.vin).toBe(input.vin.toLowerCase());
  }, 120_000);

  it('charges the seller the listing fee', async () => {
    if (!requireNode()) return;
    const user = await seller('Paying Seller');

    const before = await user.credits.balance();
    await user.listings.create(listingInput());
    const after = await user.credits.balance();

    // 3.2's $1 per 30 days, and credits has 0 decimals, so one credit.
    expect(before.units - after.units).toBe(1n);
  }, 120_000);

  it('browses active listings newest first', async () => {
    if (!requireNode()) return;
    const user = await seller('Browsing Seller');
    await user.listings.create(listingInput({ make: 'Honda', model: 'Civic' }));

    const page = await user.listings.browse({ limit: 10 });
    expect(page.length).toBeGreaterThanOrEqual(1);

    // Newest first, with the id as tiebreaker inside a block.
    for (let i = 1; i < page.length; i += 1) {
      const prev = page[i - 1]!;
      const next = page[i]!;
      const prevAt = prev.listedAt.getTime();
      const nextAt = next.listedAt.getTime();
      expect(prevAt > nextAt || (prevAt === nextAt && prev.listingId > next.listingId)).toBe(true);
    }
  }, 120_000);

  it('pages on a cursor that survives a shared timestamp', async () => {
    if (!requireNode()) return;
    const user = await seller('Paging Seller');
    for (const model of ['Yaris', 'Auris', 'Aygo']) {
      await user.listings.create(listingInput({ model }));
    }

    const first = await user.listings.browse({ limit: 2 });
    expect(first).toHaveLength(2);

    const cursor = first[1]!;
    const second = await user.listings.browse({
      limit: 2,
      after: { listedAt: cursor.listedAt, listingId: cursor.listingId },
    });

    // No overlap: the cursor is strictly exclusive on (created_at, id).
    const firstIds = first.map((l) => l.listingId);
    for (const listing of second) {
      expect(firstIds).not.toContain(listing.listingId);
    }
  }, 180_000);

  /**
   * The facets, which are the queries most likely to be rejected outright.
   * value_number is NUMERIC(38,10) and there is no implicit promotion, so an
   * uncast bound fails with "comparison operands must be of the same type".
   */
  it('filters on make, year range and price ceiling', async () => {
    if (!requireNode()) return;
    const user = await seller('Faceted Seller');
    await user.listings.create(
      listingInput({ make: 'Subaru', model: 'Outback', year: 2019, price: '9500' })
    );

    // Case-insensitive because the write folded it, not because the query does.
    const hit = await user.listings.search({ make: 'SUBARU', yearFrom: 2018, maxPrice: '10000' });
    expect(hit.some((l) => l.make === 'subaru')).toBe(true);

    const tooOld = await user.listings.search({ make: 'subaru', yearFrom: 2020 });
    expect(tooOld.some((l) => l.make === 'subaru')).toBe(false);

    const tooDear = await user.listings.search({ make: 'subaru', maxPrice: '9000' });
    expect(tooDear.some((l) => l.make === 'subaru')).toBe(false);

    const outOfRange = await user.listings.search({ make: 'subaru', yearFrom: 2010, yearTo: 2015 });
    expect(outOfRange.some((l) => l.make === 'subaru')).toBe(false);
  }, 180_000);

  it('closes a listing and takes it out of the shop window', async () => {
    if (!requireNode()) return;
    const user = await seller('Closing Seller');
    await user.listings.create(listingInput({ model: 'Prius' }));

    const [listing] = await user.listings.mine();
    const id = listing!.listingId;

    await user.listings.close(id, 'sold');

    // The seller still sees it -- they need to know what they sold.
    const mine = await user.listings.mine();
    expect(mine.find((l) => l.listingId === id)?.state).toBe('sold');

    // Buyers do not.
    const page = await user.listings.browse({ limit: 200 });
    expect(page.map((l) => l.listingId)).not.toContain(id);

    // get_listing is a record lookup, not a shop window: someone following a
    // link to a listing that ended should be told it ended, not that it never
    // existed.
    await expect(user.listings.get(id)).resolves.toMatchObject({ state: 'sold' });
  }, 150_000);

  it('refuses a second active listing for the same VIN', async () => {
    if (!requireNode()) return;
    const user = await seller('Duplicating Seller');
    const vin = uniqueVin();

    await user.listings.create(listingInput({ vin }));
    // Typed differently on the second attempt, to prove the guard is on the
    // folded value rather than the exact string.
    await expect(user.listings.create(listingInput({ vin: vin.toLowerCase() }))).rejects.toThrow(
      ActionFailedError
    );
  }, 150_000);

  it('refuses an outcome the action does not accept', async () => {
    if (!requireNode()) return;
    const user = await seller('Bad Outcome Seller');
    await user.listings.create(listingInput({ model: 'Hilux' }));
    const [listing] = await user.listings.mine();

    await expect(user.listings.close(listing!.listingId, 'stolen' as 'sold')).rejects.toThrow(
      ActionFailedError
    );
  }, 150_000);
});

/**
 * The eight optional descriptors, against a live node.
 *
 * Six of them were declared for months with no way to write them, so the
 * failure this guards is not a wrong value but a missing row -- which the write
 * side cannot see, because create_listing succeeded either way.
 *
 * And the detail query now carries twenty LEFT JOINs. Whether kwil's planner
 * accepts that is not something a stub can be asked.
 */
describe('optional descriptors', () => {
  it('writes all eight, and reads them back off a twenty-join detail query', async () => {
    if (!requireNode()) return;
    const client = await seller('Descriptor Seller');

    await client.listings.create({
      ...listingInput(),
      // Title-cased on the way in, so a missing fold shows up here rather than
      // as a facet filter that quietly finds nothing.
      bodyStyle: 'Pickup',
      transmission: 'Automatic',
      fuelType: 'Diesel',
      exteriorColor: 'White',
      condition: 'Used',
      titleStatus: 'Clean',
      acceptsOffers: true,
      acceptsTrade: false,
    });

    const [own] = await client.listings.mine({ limit: 1 });
    const listing = await client.listings.get(own!.listingId);

    expect(listing?.bodyStyle).toBe('pickup');
    expect(listing?.transmission).toBe('automatic');
    expect(listing?.fuelType).toBe('diesel');
    expect(listing?.exteriorColor).toBe('white');
    expect(listing?.condition).toBe('used');
    expect(listing?.titleStatus).toBe('clean');

    expect(listing?.acceptsOffers).toBe(true);
    // FALSE IS NOT NULL. The seller declined, and that answer has to survive
    // the round trip as an answer.
    expect(listing?.acceptsTrade).toBe(false);
  }, 120_000);

  it('leaves every descriptor null when the seller was never asked', async () => {
    if (!requireNode()) return;
    const client = await seller('Quiet Seller');
    await client.listings.create(listingInput());

    const [own] = await client.listings.mine({ limit: 1 });
    const listing = await client.listings.get(own!.listingId);

    expect(listing?.bodyStyle).toBeNull();
    expect(listing?.titleStatus).toBeNull();
    // Null, not false: nobody asked, so nobody declined. Every listing
    // published before these fields existed reads exactly like this.
    expect(listing?.acceptsOffers).toBeNull();
    expect(listing?.acceptsTrade).toBeNull();
  }, 120_000);

  it('carries the two flags on the browse summary, where a card can see them', async () => {
    if (!requireNode()) return;
    const client = await seller('Offer Seller');
    const vin = uniqueVin();
    await client.listings.create({
      ...listingInput({ vin, make: 'Mazda', model: `Obo${Date.now().toString(36)}` }),
      acceptsOffers: true,
      acceptsTrade: false,
    });

    const [own] = await client.listings.mine({ limit: 1 });
    const found = (await client.listings.search({ limit: 50 })).find(
      (l) => l.listingId === own!.listingId
    );

    expect(found, 'the listing did not come back from search').toBeTruthy();
    expect(found?.acceptsOffers).toBe(true);
    expect(found?.acceptsTrade).toBe(false);
  }, 120_000);

  it('carries photo URLs on the browse summary, where a card needs them', async () => {
    if (!requireNode()) return;
    const client = await seller('Photo Seller');
    const url = 'https://objects.test/browse-' + Date.now().toString(36) + '.jpg';

    await client.listings.create({ ...listingInput(), photos: [url] });

    const [own] = await client.listings.mine({ limit: 1 });
    const found = (await client.listings.search({ limit: 50 })).find(
      (l) => l.listingId === own!.listingId
    );

    expect(found, 'the listing did not come back from search').toBeTruthy();
    // The whole point: no second query per card. A grid of twelve listings is
    // one round trip, not thirteen.
    expect(found?.photos).toEqual([url]);
  }, 120_000);
});
