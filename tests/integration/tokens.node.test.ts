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
 * The generic token surface against a live node.
 *
 * WHAT ONLY A NODE CAN ANSWER. The unit suites assert the SHAPE of a call --
 * which action, which inputs, which declared types -- against a double that
 * records it. Whether kwil's planner accepts the parameter arrays, the keyset
 * cursor comparison and the NUMERIC casts is a different question, and
 * `branch/CLAUDE.md` is explicit about which answer counts: a double written
 * from an assumption confirms the assumption.
 *
 * Three of this package's hardest-won facts were found by running a query rather
 * than by reading one: that a `NUMERIC(38,10)[]` whose elements are all NULL
 * arrives as `numeric(0,0)[]` and is refused, that nothing infers to NUMERIC,
 * and that a join cannot reference a table appearing later in the FROM list.
 *
 * REPLACES listings.node.test.ts, which drove the same node through a
 * car-shaped client. The car fields survive as FIXTURES -- the dev stack seeds
 * an automobile directory, so that is the type available to test against -- but
 * nothing here is addressed by anything except a slug and a declared identifier.
 */

const PROVIDER = process.env.BRANCH_PROVIDER ?? 'http://127.0.0.1:8484';
const EXPLICIT = process.env.BRANCH_PROVIDER !== undefined;
const AMOUNT_IS_NUMERIC = { $amount: numeric(78, 0) };

/**
 * The type to drive. Whatever directory the node has; the dev stack seeds this one.
 *
 * `npm run stack:seed` in island-nook-directory-45 creates it. Override with
 * TEST_TYPE_SLUG to run against a different directory.
 */
const TYPE_SLUG = process.env.TEST_TYPE_SLUG ?? 'automobile-listing';

let chainId = '';
let reachable = false;
let reason = '';

beforeAll(async () => {
  try {
    chainId = await fetchChainId(PROVIDER);
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
    return;
  }
  /*
    IS IT OUR CHAIN, not merely a chain?
    `fetchChainId` answers "something speaks kwil here", which is a weaker
    question. On 2026-10-05 another project's node on this port answered it, a
    stack brought nothing up, and migrations were broadcast to a chain that
    refused them -- every step reporting success. So the node is asked for
    something only a Branch chain has before anything else runs.
  */
  try {
    const probe = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });
    await probe.types.current(TYPE_SLUG);
    reachable = true;
  } catch (err) {
    reason =
      `a node answered on ${PROVIDER} as chain '${chainId}' but has no '${TYPE_SLUG}' type: ` +
      (err instanceof Error ? err.message : String(err));
  }
});

function requireNode(): boolean {
  if (reachable) return true;
  if (EXPLICIT) {
    throw new Error(`BRANCH_PROVIDER is set to ${PROVIDER}: ${reason}`);
  }
  console.warn(`${reason || `no Branch node at ${PROVIDER}`} -- skipping`);
  return false;
}

async function connect(privateKey?: string): Promise<BranchClient> {
  const { address, signer } = await localWallet(privateKey);
  return await BranchClient.connect({ provider: PROVIDER, chainId, address, signer });
}

/** A registered issuer with enough credits to pay a publishing fee. */
async function issuer(name: string): Promise<BranchClient> {
  const client = await connect();
  await client.identity.register(name);
  const operator = await connect(OPERATOR_KEY);
  await operator.write(
    'issue_credits',
    { $to_address: client.address, $amount: '500', $reference: 'tokens-integration' },
    AMOUNT_IS_NUMERIC
  );
  return client;
}

/** A value nobody else in this run will use, for a uniquely-scoped field. */
const unique = (): string =>
  `1HGBH41JX${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;

/**
 * Values for the fields this node's type declares.
 *
 * FIXTURES, NOT AN API. `tokens.mint` takes identifiers and values; which
 * identifiers exist is the type's business, and these are the ones the dev
 * stack's directory happens to declare.
 */
const mintInput = (typeId: number, over: Record<string, unknown> = {}) => ({
  typeId,
  stateName: 'active',
  name: '2018 Toyota Corolla',
  durationDays: 30,
  text: {
    make: 'toyota',
    model: 'corolla',
    price_currency: 'credits',
    location: 'Susupe',
    vin: unique(),
    description: 'Runs well.',
  },
  numbers: { price: '12750', year: '2018', mileage: '90000' },
  booleans: { accepts_offers: true, accepts_trade: false },
  json: { photos: ['a.jpg'] },
  brokered: { contact: 'a'.repeat(64) },
  ...over,
});

describe('the reads batch, against a live node', () => {
  const SELLER = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';

  it('carries the issuer ids, so ownership is a comparison and not a guess', async () => {
    /*
      WHAT THIS REPLACES: `issuerPerson` is coalesce(display_name, handle), so
      deciding "is this mine" meant comparing NAMES -- and two sellers sharing a
      display name each got the other's withdraw button.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const hits = await client.tokens.search(TYPE_SLUG, { limit: 1 });
    const first = hits[0];
    expect(first).toBeDefined();

    const record = await client.tokens.get(first?.tokenId ?? 0n);
    expect(record).not.toBeNull();
    // A listing is issued by somebody, so exactly one of the two is set.
    const ids = [record?.issuerPersonId ?? null, record?.issuerGroupId ?? null];
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    const issuer = record?.issuerPersonId ?? record?.issuerGroupId;
    expect(Number.isInteger(issuer)).toBe(true);
  });

  it('answers who may moderate, both ways, and folds the address', async () => {
    // A check that only ever says yes is not a check, so both directions.
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    // The seeded seller holds no office.
    await expect(client.types.mayModerate(TYPE_SLUG, SELLER)).resolves.toBe(false);

    // An unregistered address is FALSE, not a throw: "nobody" and "holds no
    // office" are the same answer to "show the control?".
    await expect(
      client.types.mayModerate(TYPE_SLUG, '0x0000000000000000000000000000000000000001')
    ).resolves.toBe(false);

    // Mixed case must not change the answer for whatever the answer is -- a
    // client-side lower() would mask the chain failing to fold.
    const lower = await client.types.mayModerate(TYPE_SLUG, SELLER);
    const upper = await client.types.mayModerate(TYPE_SLUG, '0x' + SELLER.slice(2).toUpperCase());
    expect(upper).toBe(lower);
  });

  it('lists what an address holds, paged contiguously', async () => {
    /*
      THE CURSOR IS THE SUBJECT. A row count cannot see a cursor that repeats or
      skips, so the pages are compared against the unpaged read.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const all = await client.holdings.of(SELLER, { limit: 200 });
    expect(all.length).toBeGreaterThan(1);

    // The seeded seller holds credits AND their own listings: one fungible row
    // among non-fungible ones, which is the profile shape.
    expect(all.some((h) => h.isFungible)).toBe(true);
    expect(all.some((h) => !h.isFungible)).toBe(true);
    for (const held of all) {
      expect(held.quantity).toBeGreaterThan(0n);
      expect(typeof held.quantity).toBe('bigint');
    }

    const page = await client.holdings.of(SELLER, { limit: 2 });
    expect(page).toHaveLength(2);
    const next = await client.holdings.of(SELLER, {
      limit: 2,
      after: page[1]?.tokenId ?? 0n,
    });
    const walked = [...page, ...next].map((h) => h.tokenId);
    expect(walked).toEqual(all.slice(0, walked.length).map((h) => h.tokenId));
  });

  it('CANNOT tell an unregistered address from one holding nothing', async () => {
    /*
      ASSERTS A LIMITATION, NOT A FEATURE. `holdings_of` refuses an unregistered
      address by name -- and a view action's ERROR() does not cross the wire, so
      the refusal arrives as zero rows. For a TABLE action zero rows is also a
      true answer: a registered address holding nothing. So both come back empty
      and nothing can separate them.

      This is the third time that rule has caught me, which is why it is written
      down in the README. `types.states` can infer a refusal because a live type
      always declares a state; here an empty answer is legitimate, so it cannot.

      A caller needing the difference asks `credits.balanceOf`, a single-row
      action, which does throw.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    await expect(client.holdings.of('0x0000000000000000000000000000000000000001')).resolves.toEqual(
      []
    );

    await expect(
      client.credits.balanceOf('0x0000000000000000000000000000000000000001')
    ).rejects.toThrow();
  });
});

describe('balances and states, against a live node', () => {
  // The seeded seller: a fixed public key, see island-nook's scripts/stack/seed.mjs.
  const SELLER = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';

  it('reads a credit balance for an address that is not the caller', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const held = await client.credits.balanceOf(SELLER);
    expect(held.units).toBeGreaterThan(0n);
    expect(held.decimals).toBe(0);
  });

  it('FOLDS A MIXED-CASE ADDRESS, which a client-side lower() would mask', async () => {
    /*
      THE TRAP THIS EXISTS TO CATCH. `person_keys.address` is lowercase and an
      EIP-55 address is mixed case, so a bare comparison matches nothing AND
      REPORTS SUCCESS. The action folds it; this asserts the action does, rather
      than asserting that the SDK worked around it.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const lower = await client.credits.balanceOf(SELLER);
    const upper = await client.credits.balanceOf('0x' + SELLER.slice(2).toUpperCase());
    expect(upper.units).toBe(lower.units);
    expect(upper.units).toBeGreaterThan(0n);
  });

  it('throws for an unregistered address rather than answering zero', async () => {
    // "Nobody" and "nothing" are different answers, and collapsing them is how a
    // typo'd address reads as an empty wallet.
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    await expect(
      client.credits.balanceOf('0x0000000000000000000000000000000000000001')
    ).rejects.toThrow();
  });

  it('reads one token holding as bare units', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    // The credits token is the one fungible token every chain has.
    const held = await client.tokens.holdingOf(SELLER, 1);
    expect(typeof held).toBe('bigint');
    expect(held).toBeGreaterThanOrEqual(0n);
  });

  it('reads a currency balance by code, and refuses an unknown code', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const held = await client.currencies.balanceOf(SELLER, 'demo-usd');
    expect(held.units).toBeGreaterThanOrEqual(0n);

    /*
      IT THROWS, BUT NOT WITH THE CHAIN'S MESSAGE. The action says `no currency
      with the code no-such-currency`; a view action's ERROR() does not cross the
      wire, so what arrives is zero rows and the SDK's own `returned no row`.

      Asserted as it behaves rather than as it ought to, because the gap is the
      transport's and pretending otherwise would make this test a fiction.
    */
    await expect(client.currencies.balanceOf(SELLER, 'no-such-currency')).rejects.toThrow(
      /returned no row/
    );
  });

  it("lists a type's states in lifecycle order, with the live one first", async () => {
    /*
      THE ONE WITH TEETH. close_token and moderate_token take a state NAME, and
      nothing public listed the names -- so a directory added by definition alone
      was browsable and not actionable. Read off the chain rather than named here,
      so it keeps asserting as a directory's lifecycle changes.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const states = await client.types.states(TYPE_SLUG);
    expect(states.length).toBeGreaterThan(1);

    const first = states[0];
    expect(first?.isInitial).toBe(true);
    // Issuance lands here, so by definition it cannot be an ending.
    expect(first?.isTerminal).toBe(false);

    // Ordinals ascend, which is what "lifecycle order" means.
    const ordinals = states.map((s) => s.ordinal);
    expect([...ordinals].sort((a, b) => a - b)).toEqual(ordinals);

    // Exactly one initial state, and at least one ending.
    expect(states.filter((s) => s.isInitial)).toHaveLength(1);
    expect(states.some((s) => s.isTerminal)).toBe(true);

    for (const state of states) {
      expect(state.name).toBe(state.name.toLowerCase());
      expect(state.label.length).toBeGreaterThan(0);
    }
  });

  it("names the expiry state, which is terminal and NOT a seller's to choose", async () => {
    /*
      close_token moves a record INTO a terminal state, so the transitions to
      offer a seller are the terminal ones -- minus this, which belongs to the
      permissionless sweep. Without this read a generated page offers "mark as
      expired" beside "mark as sold".
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const { typeId } = await client.types.current(TYPE_SLUG);
    const expiry = await client.types.expiryState(typeId);
    expect(expiry).not.toBeNull();

    const states = await client.types.states(TYPE_SLUG);
    const named = states.find((s) => s.name === expiry);
    expect(named).toBeDefined();
    expect(named?.isTerminal).toBe(true);

    // And there is at least one OTHER terminal state, or a seller could close a
    // record into nothing at all.
    const sellerMay = states.filter((s) => s.isTerminal && s.name !== expiry);
    expect(sellerMay.length).toBeGreaterThan(0);
  });

  it('refuses an unknown family when listing states', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    // The SDK infers the refusal from zero rows -- a live type always declares a
    // state -- so the family name does reach the caller, via the SDK rather than
    // the chain.
    await expect(client.types.states('no-such-family-here')).rejects.toThrow(/no-such-family-here/);
  });
});

describe('types, against a live node', () => {
  it('resolves the live version of a family', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const version = await client.types.current(TYPE_SLUG);
    expect(version.typeSlug).toBe(TYPE_SLUG);
    expect(version.typeId).toBeGreaterThan(0);
    expect(version.typeVersion).toBeGreaterThan(0);
  });

  it('answers what the type declares, with the shared declarations merged in', async () => {
    /*
      THE MERGE IS THE CHAIN'S. A field declared at `token_type_id IS NULL`
      applies to every type and a type-scoped declaration of the same identifier
      wins -- `token_type_schema` applies that with a correlated NOT EXISTS. A
      unit test cannot tell whether the SQL does it; this can.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const schema = await client.types.schema(TYPE_SLUG);
    expect(schema.fields.length).toBeGreaterThan(0);
    for (const f of schema.fields) {
      expect(['text', 'number', 'boolean', 'datetime', 'json', 'uri']).toContain(f.datatype);
      expect(['none', 'class', 'global', 'type_active']).toContain(f.uniqueScope);
      expect(f.label.length).toBeGreaterThan(0);
    }
    // A brokered field names its custodian, which is what a page shows instead
    // of a value it must never hold.
    const brokered = schema.fields.filter((f) => f.requiresCustodian);
    for (const f of brokered) {
      expect(f.custodianGroupId ?? f.custodianPersonId).not.toBeNull();
    }
  });

  it('answers for one version by id, which is what a record carries', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const { typeId } = await client.types.current(TYPE_SLUG);
    const byId = await client.types.versionSchema(typeId);
    const live = await client.types.schema(TYPE_SLUG);
    expect(byId.map((f) => f.identifier)).toEqual(live.fields.map((f) => f.identifier));
  });

  it('refuses a family that is not on this chain, by name', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    await expect(client.types.current('no-such-family-here')).rejects.toThrow(
      /no-such-family-here/
    );
  });

  it('offers facet options read off the live records', async () => {
    /*
      ONLY THE NODE HAS THESE. A double would return whatever I believed the
      grouping to be, which is the failure mode badger-cash/branch#113 was
      written up for: a test double written from an assumption confirms the
      assumption.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const byField = await client.types.fieldValues(TYPE_SLUG, ['make', 'condition']);

    const makes = byField.get('make');
    expect(makes).toBeDefined();
    expect(makes?.length).toBeGreaterThan(0);
    // FOLDED, so lowercase, and that is the needle a filter sends back.
    for (const option of makes ?? []) {
      expect(option.value).toBe(option.value.toLowerCase());
      expect(option.count).toBeGreaterThan(0);
      expect(Number.isInteger(option.count)).toBe(true);
    }
  });

  it('narrows one field by another, which only the node can answer', async () => {
    /*
      A DEPENDENT FACET (branch#133). Unnarrowed this is every model in the
      family; narrowed by a make it is that make's models. A double would return
      whichever I believed, and co-occurrence is exactly what I could not check
      by reading.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const all = await client.types.fieldValues(TYPE_SLUG, ['model'], { maxValues: 500 });
    const everyModel = all.get('model') ?? [];
    /*
      A PRECONDITION THAT SAYS SO. This needs the seeded fixture -- several makes
      with several models each -- and without it the assertion below fails as
      `expected 1 to be greater than 1`, which names neither the seed nor the
      chain. It read as the narrowing being broken when the chain had simply been
      reset under an e2e suite that mints one car of its own.
    */
    if (everyModel.length < 2) {
      throw new Error(
        `this test needs the seeded fixture: the chain has ${everyModel.length} distinct ` +
          `'model' value(s). Run 'npm run stack:seed' in island-nook-directory-45.`
      );
    }
    expect(everyModel.length).toBeGreaterThan(1);

    const makes = await client.types.fieldValues(TYPE_SLUG, ['make'], { maxValues: 500 });
    const firstMake = makes.get('make')?.[0]?.value;
    expect(firstMake).toBeDefined();

    const narrowed = await client.types.fieldValues(TYPE_SLUG, ['model'], {
      maxValues: 500,
      narrowBy: [{ identifier: 'make', value: firstMake ?? '' }],
    });
    const some = narrowed.get('model') ?? [];
    expect(some.length).toBeGreaterThan(0);
    // A proper subset, as long as the directory has more than one make.
    expect(some.length).toBeLessThan(everyModel.length);
    for (const option of some) {
      expect(everyModel.map((o) => o.value)).toContain(option.value);
    }
  });

  it('folds a needle per declaration rather than blanket, which is the silent case', async () => {
    /*
      THE PAIR THAT MATTERS. `make` is declared folded, so an upper-case needle
      still matches. An unfolded field must match only the case it was stored in.
      A blanket lowercase passes the first and silently fails the second --
      returning nothing and reporting success.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const makes = await client.types.fieldValues(TYPE_SLUG, ['make'], { maxValues: 500 });
    const stored = makes.get('make')?.[0]?.value ?? '';
    expect(stored).toBe(stored.toLowerCase());

    const upper = await client.types.fieldValues(TYPE_SLUG, ['model'], {
      narrowBy: [{ identifier: 'make', value: stored.toUpperCase() }],
    });
    expect((upper.get('model') ?? []).length).toBeGreaterThan(0);

    // An unfolded value found from the data rather than named: one whose stored
    // form is not already lowercase can only be unfolded.
    const places = await client.types.fieldValues(TYPE_SLUG, ['location'], { maxValues: 500 });
    const mixed = (places.get('location') ?? []).find((o) => o.value !== o.value.toLowerCase());
    if (mixed === undefined) return;

    const right = await client.types.fieldValues(TYPE_SLUG, ['make'], {
      narrowBy: [{ identifier: 'location', value: mixed.value }],
    });
    expect((right.get('make') ?? []).length).toBeGreaterThan(0);

    const wrong = await client.types.fieldValues(TYPE_SLUG, ['make'], {
      narrowBy: [{ identifier: 'location', value: mixed.value.toLowerCase() }],
    });
    expect(wrong.size).toBe(0);
  });

  it('withholds a field whose values outnumber the cap, rather than truncating it', async () => {
    /*
      THE CAP IS THE FEATURE. At a cap of 1, a field with two or more distinct
      values must vanish entirely -- not come back with one option, which would
      be a dropdown where every entry works and the absent ones read as records
      that do not exist.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const generous = await client.types.fieldValues(TYPE_SLUG, ['make'], { maxValues: 500 });
    const distinct = generous.get('make')?.length ?? 0;
    expect(distinct).toBeGreaterThan(1);

    const tight = await client.types.fieldValues(TYPE_SLUG, ['make'], { maxValues: distinct - 1 });
    expect(tight.has('make')).toBe(false);

    // And exactly at the cap it is still offered, in full.
    const exact = await client.types.fieldValues(TYPE_SLUG, ['make'], { maxValues: distinct });
    expect(exact.get('make')?.length).toBe(distinct);
  });

  it('says nothing about a brokered field, without being told it is brokered', async () => {
    /*
      `contact` requires a custodian, so the chain holds an HMAC and no
      cleartext. Uncapped, so an absence here cannot be the cap doing the work.
      Nothing in the SDK or the action names this field.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const schema = await client.types.schema(TYPE_SLUG);
    const brokered = schema.fields.find((f) => f.requiresCustodian);
    expect(brokered).toBeDefined();

    const byField = await client.types.fieldValues(TYPE_SLUG, [brokered?.identifier ?? 'contact'], {
      maxValues: 500,
    });
    expect(byField.size).toBe(0);
  });

  it('CANNOT report the chain refusing an unknown family, because a view error is dropped', async () => {
    /*
      THIS ASSERTS A LIMITATION, NOT A FEATURE, and it is here so the limitation
      cannot be discovered twice.

      `type_field_values` refuses an unknown family on chain, by name --
      badger-cash/branch#128 added that guard precisely so an empty filter set
      could not be mistaken for "no values yet". The guard works, and the e2e
      suite in `branch` proves it through the CLI's TEXT output.

      It cannot reach a client. A refused view action answers
      `{"status":200,"data":{"result":[],"logs":""}}` -- success, no rows, no
      error field, no message. Probed against this node. So the refusal arrives
      as an ordinary empty result and nothing can tell the two apart.

      The practical rule, documented in the README: validate the family with
      `schema()` or `current()`, which DO throw, before trusting an empty answer
      out of here. The test above for `types.current` is what that relies on.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const byField = await client.types.fieldValues('no-such-family-here', ['make']);
    expect(byField.size).toBe(0);

    // The validating call, which is the one a caller must actually rely on.
    await expect(client.types.current('no-such-family-here')).rejects.toThrow(
      /no-such-family-here/
    );
  });

  it('gives the rate card in whole credits, cheapest first', async () => {
    /*
      SCALE 0, NOT 10. The stored rate is NUMERIC(38,10) but the ledger is scale
      0, and a fee handed back unrounded produces `units` a thousand million
      times larger than a balance's. Only the node has the real rates.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const tiers = await client.types.feeTiers(TYPE_SLUG);
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) expect(t.fee.decimals).toBe(0);
    expect([...tiers].sort((a, b) => a.durationDays - b.durationDays)).toEqual(tiers);
  });
});

describe('tokens, against a live node', () => {
  it('mints a record with every kind of field and reads it back whole', async () => {
    if (!requireNode()) return;
    const client = await issuer('Integration Issuer');
    const { typeId } = await client.types.current(TYPE_SLUG);

    const input = mintInput(typeId);
    await client.tokens.mint(input);

    const [hit] = await client.tokens.mine(TYPE_SLUG, { limit: 1 });
    expect(hit).toBeDefined();
    const record = await client.tokens.get(hit!.tokenId);

    expect(record?.name).toBe(input.name);
    expect(record?.typeSlug).toBe(TYPE_SLUG);
    expect(record?.issuerPerson).toBe('Integration Issuer');

    const f = record!.fields;
    expect(f.get('make')?.text).toBe('toyota');
    // A NUMERIC arrives as a DECIMAL STRING of the value, not pre-scaled units.
    expect(f.get('price')?.number).toMatch(/^12750(\.0+)?$/);
    expect(f.get('accepts_offers')?.boolean).toBe(true);
    // An explicit false is a row saying so, not an absent one.
    expect(f.get('accepts_trade')?.boolean).toBe(false);
    expect(f.get('photos')?.json).toContain('a.jpg');
    /*
      THE COMMITMENT, NEVER THE VALUE -- and `get_token` does not return even the
      commitment. It selects no `value_hmac`, so a detail page gets the
      custodian's NAME to show and nothing else; `token_fields` is the action that
      carries the HMAC. Asserted both ways here because the asymmetry is real and
      invisible until something depends on it.
    */
    const contact = f.get('contact');
    expect(contact?.custodianName).not.toBeNull();
    expect(contact?.text).toBeNull();
    expect(contact?.number).toBeNull();
    expect(contact?.json).toBeNull();
    expect(contact?.hmacHex).toBeNull();

    const batched = await client.tokens.fields([hit!.tokenId]);
    expect(batched.get(String(hit!.tokenId))?.get('contact')?.hmacHex).not.toBeNull();
    // The term the chain computed from the paid duration.
    expect(f.get('expires_at')?.datetime).toBeGreaterThan(0);
  });

  it('charges the issuer the type fee', async () => {
    if (!requireNode()) return;
    const client = await issuer('Paying Issuer');
    const { typeId } = await client.types.current(TYPE_SLUG);
    const tiers = await client.types.feeTiers(TYPE_SLUG);
    const tier = tiers.find((t) => t.durationDays === 30) ?? tiers[0]!;

    const before = await client.credits.balance();
    await client.tokens.mint(mintInput(typeId, { durationDays: tier.durationDays }));
    const after = await client.credits.balance();

    expect(formatAmount(before)).not.toBe(formatAmount(after));
    expect(after.units).toBe(before.units - tier.fee.units);
  });

  it('searches unfiltered, newest first', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const hits = await client.tokens.search(TYPE_SLUG, { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    const times = hits.map((h) => h.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    for (const h of hits) expect(h.tokenId).toBeTypeOf('bigint');
  });

  it('filters on a text facet without the caller folding it', async () => {
    /*
      THE NODE FOLDS THE NEEDLE, per declaration:
      `m.value_text = CASE WHEN d.folded THEN lower(q.v) ELSE q.v END`.
      So a MIXED-CASE needle must match a folded field. This is the assertion
      that would have caught the client-side fold being wrong.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const mixed = await client.tokens.search(TYPE_SLUG, {
      text: [{ identifier: 'make', value: 'Toyota' }],
      limit: 20,
    });
    const lower = await client.tokens.search(TYPE_SLUG, {
      text: [{ identifier: 'make', value: 'toyota' }],
      limit: 20,
    });
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed.map((h) => String(h.tokenId))).toEqual(lower.map((h) => String(h.tokenId)));
  });

  it('filters on a one-sided numeric range, which is the shape that broke', async () => {
    /*
      THE CASE THAT COULD NOT BE CALLED. Bounds were NUMERIC(38,10)[] and an
      array whose elements are ALL NULL arrives as numeric(0,0)[] and is refused
      -- which is exactly what `year >= 2015` with no upper bound produces. The
      common case was the broken one and it passed a unit test against a fake.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const from = await client.tokens.search(TYPE_SLUG, {
      ranges: [{ identifier: 'year', min: 2000 }],
      limit: 20,
    });
    const to = await client.tokens.search(TYPE_SLUG, {
      ranges: [{ identifier: 'year', max: 2100 }],
      limit: 20,
    });
    const both = await client.tokens.search(TYPE_SLUG, {
      ranges: [{ identifier: 'year', min: 2000, max: 2100 }],
      limit: 20,
    });
    expect(from.length).toBeGreaterThan(0);
    expect(to.length).toBeGreaterThan(0);
    expect(both.length).toBeGreaterThan(0);
  });

  it('filters on a boolean facet, and requires every facet rather than any', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const flagged = await client.tokens.search(TYPE_SLUG, {
      booleans: [{ identifier: 'accepts_offers', value: true }],
      limit: 20,
    });
    const impossible = await client.tokens.search(TYPE_SLUG, {
      text: [
        { identifier: 'make', value: 'toyota' },
        { identifier: 'model', value: 'no-such-model-exists' },
      ],
      limit: 20,
    });
    expect(flagged.length).toBeGreaterThan(0);
    // ALL of them, not any: a conjunction nobody can satisfy returns nothing.
    expect(impossible).toEqual([]);
  });

  it('pages on a cursor that survives a shared timestamp', async () => {
    /*
      A KEYSET, NOT AN OFFSET, and the reason is correctness rather than speed:
      several records minted in one block share a `created_at`, so an ORDER BY on
      the timestamp alone is not a total order and a page boundary can repeat or
      skip a row. The comparison is `(created_at, id)`, which only a node can
      confirm the planner accepts.
    */
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const first = await client.tokens.search(TYPE_SLUG, { limit: 2 });
    if (first.length < 2) return;
    const last = first[first.length - 1]!;
    const next = await client.tokens.search(TYPE_SLUG, {
      limit: 2,
      after: { createdAt: last.createdAt, tokenId: last.tokenId },
    });

    const seen = new Set(first.map((h) => String(h.tokenId)));
    for (const h of next) expect(seen.has(String(h.tokenId))).toBe(false);
  });

  it('reads many records fields in one call, with each custodian url resolved', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });

    const hits = await client.tokens.search(TYPE_SLUG, { limit: 3 });
    const fields = await client.tokens.fields(hits.map((h) => h.tokenId));

    expect(fields.size).toBe(hits.length);
    for (const h of hits) {
      const f = fields.get(String(h.tokenId));
      expect(f?.size).toBeGreaterThan(0);
      // `token_fields` carries custodian_url per row, which is what makes a
      // third round trip for a photo base unnecessary.
      const photos = f?.get('photos');
      if (photos !== undefined) expect(photos.custodianUrl).not.toBeNull();
    }
  });

  it('makes no call at all for no ids', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });
    await expect(client.tokens.fields([])).resolves.toEqual(new Map());
  });

  it('closes a record as its owner, and it leaves the live set', async () => {
    if (!requireNode()) return;
    const client = await issuer('Closing Issuer');
    const { typeId } = await client.types.current(TYPE_SLUG);
    await client.tokens.mint(mintInput(typeId));
    const [hit] = await client.tokens.mine(TYPE_SLUG, { limit: 1 });

    await client.tokens.close(hit!.tokenId, 'sold');

    const after = await client.tokens.get(hit!.tokenId);
    expect(after?.state).toBe('sold');
    expect(after?.isTerminal).toBe(true);
    // `search_tokens` excludes terminal states, so it is out of the shop window.
    const live = await client.tokens.search(TYPE_SLUG, { limit: 50 });
    expect(live.map((h) => String(h.tokenId))).not.toContain(String(hit!.tokenId));
    // But its own issuer still sees it, because `mine` is not filtered.
    const mine = await client.tokens.mine(TYPE_SLUG, { limit: 50 });
    expect(mine.map((h) => String(h.tokenId))).toContain(String(hit!.tokenId));
  });

  it('refuses a state the type does not declare, and names it', async () => {
    /*
      THE CHAIN OWNS THIS RULE, which is why there is no client-side check.
      `type_state` errors `this type has no state named X`, and that log is the
      message worth showing a user.
    */
    if (!requireNode()) return;
    const client = await issuer('Refused Issuer');
    const { typeId } = await client.types.current(TYPE_SLUG);
    await client.tokens.mint(mintInput(typeId));
    const [hit] = await client.tokens.mine(TYPE_SLUG, { limit: 1 });

    await expect(client.tokens.close(hit!.tokenId, 'zzz-not-a-state')).rejects.toThrow(
      ActionFailedError
    );
    await expect(client.tokens.close(hit!.tokenId, 'zzz-not-a-state')).rejects.toThrow(
      /no state named/
    );
  });

  it('refuses a moderation from somebody holding no office', async () => {
    // Authority is read from the TYPE -- `token_types.burning_role_id` -- so a
    // client that offers the button still gets refused by the node.
    if (!requireNode()) return;
    const owner = await issuer('Owner');
    const { typeId } = await owner.types.current(TYPE_SLUG);
    await owner.tokens.mint(mintInput(typeId));
    const [hit] = await owner.tokens.mine(TYPE_SLUG, { limit: 1 });

    const stranger = await connect();
    await stranger.identity.register('Not A Moderator');
    await expect(
      stranger.tokens.moderate(hit!.tokenId, 'withdrawn', 'because I say so')
    ).rejects.toThrow(ActionFailedError);
  });

  it('enforces a uniquely-scoped field among live records', async () => {
    /*
      `unique_scope = 'type_active'` means unique among records of this type
      whose state is not terminal -- the rule the other three values cannot
      express. Enforced by the chain, so only the chain can confirm it.
    */
    if (!requireNode()) return;
    const client = await issuer('Unique Issuer');
    const { typeId } = await client.types.current(TYPE_SLUG);
    const schema = await client.types.schema(TYPE_SLUG);
    const scoped = schema.fields.find((f) => f.uniqueScope === 'type_active');
    if (scoped === undefined) return;

    const value = unique();
    const first = mintInput(typeId);
    (first.text as Record<string, unknown>)[scoped.identifier] = value;
    await client.tokens.mint(first);

    const again = mintInput(typeId);
    (again.text as Record<string, unknown>)[scoped.identifier] = value;
    await expect(client.tokens.mint(again)).rejects.toThrow(ActionFailedError);
  });

  it('returns null for a record that does not exist', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });
    await expect(client.tokens.get(999_999_999)).resolves.toBeNull();
  });

  it('returns nothing for a type that does not exist, rather than failing', async () => {
    if (!requireNode()) return;
    const client = await BranchClient.connectReadOnly({ provider: PROVIDER, chainId });
    await expect(client.tokens.search('no-such-type-here', { limit: 5 })).resolves.toEqual([]);
  });
});

/*
  CREATING A DIRECTORY, END TO END, AGAINST A LIVE NODE.

  This is the test the whole generic path exists for: a directory the node has
  never heard of, declared entirely through this package, then minted into and
  searched. If it passes, adding a directory needs no script in the node
  repository and no change to this one.

  TWO CHAIN RULES THIS FOUND, both by failing:

    A FEE-MINTED TYPE NEEDS A GOVERNING ORGANIZATION -- "which is who prices it
    and nominates where the money goes". It is resolved from `governing_role_id`,
    or falls back to the group behind `moderating_role_id`. `seed-cars.sh` passes
    a null governing role and a real moderating one, which is why it works;
    passing both null is refused.

    `mint_policy` IS ONE OF fee, authorized, open. Not 'free', which is what the
    first draft of this test used.

  So a consumer creating a priced directory must know a role id, and
  `identity.myOffices()` is how it finds one -- which is why that is discovered
  here rather than hardcoded.
*/
describe('declaring a new directory against a live node', () => {
  it('creates one, declares its fields, publishes its custodian, reads it back', async () => {
    if (!requireNode()) return;

    const operator = await connect(OPERATOR_KEY);

    // DISCOVERED, NOT HARDCODED. A priced directory needs a governing
    // organization, and an office the caller holds is how a consumer names one.
    const offices = await operator.identity.myOffices();
    expect(offices.length, 'the operator holds no office; bootstrap first').toBeGreaterThan(0);
    const office = offices[0]!;

    const slug = `probe-directory-${Date.now().toString(36)}`;
    const created = await operator.types.create({
      slug,
      name: 'Probe Directory',
      description: 'A directory created by the integration suite.',
      moderatingRoleId: Number(office.roleId),
      issuerKind: 'person',
      initialStateName: 'active',
      initialStateLabel: 'Active',
      mintPolicy: 'fee',
    });
    expect(created.typeSlug).toBe(slug);
    expect(created.typeId).toBeGreaterThan(0);

    await operator.types.addState(created.typeId, {
      name: 'sold',
      label: 'Sold',
      ordinal: 2,
      isTerminal: true,
    });

    await operator.types.declareFields(created.typeId, [
      { identifier: 'headline', datatype: 'text', label: 'Headline', required: true },
      { identifier: 'probe_category', datatype: 'text', label: 'Category', folded: true },
      { identifier: 'asking_price', datatype: 'number', label: 'Asking Price', required: true },
      { identifier: 'negotiable', datatype: 'boolean', label: 'Negotiable' },
      { identifier: 'probe_serial', datatype: 'text', label: 'Serial', uniqueScope: 'type_active' },
    ]);

    /*
      THE CUSTODIAN ENDPOINT, which a directory with photographs cannot do without:
      the chain holds object keys and nothing to resolve them against, so every
      record returns zero photographs and nothing reports an error. Publishing it
      was unreachable from a consumer until now.
    */
    await operator.custodians.setForGroup(office.groupId, 'https://probe.invalid/custodian-api');
    const endpoint = await operator.custodians.forGroup(office.groupId);
    expect(endpoint?.url).toBe('https://probe.invalid/custodian-api');

    // READ IT BACK THROUGH THE SAME SURFACE A PAGE WOULD USE.
    const schema = await operator.types.schema(slug);
    expect(schema.typeId).toBe(created.typeId);

    const byId = new Map(schema.fields.map((f) => [f.identifier, f]));
    expect(byId.get('headline')?.required).toBe(true);
    expect(byId.get('asking_price')?.datatype).toBe('number');
    expect(byId.get('negotiable')?.datatype).toBe('boolean');
    expect(byId.get('probe_serial')?.uniqueScope).toBe('type_active');
    expect(byId.get('probe_category')?.label).toBe('Category');

    /*
      THE SHARED DECLARATIONS CAME TOO, and that is the chain's doing. A field
      declared at `token_type_id IS NULL` applies to every type, so a directory
      declaring five fields gets more than five back -- which is exactly why a
      consumer must not re-implement the precedence rule.
    */
    expect(schema.fields.length).toBeGreaterThanOrEqual(5);

    // And its state vocabulary took.
    const live = await operator.types.current(slug);
    expect(live.typeVersion).toBe(created.typeVersion);
  }, 180_000);

  it('mints into a directory it has just created, and finds it by a folded facet', async () => {
    if (!requireNode()) return;

    const operator = await connect(OPERATOR_KEY);
    const slug = `probe-mintable-${Date.now().toString(36)}`;

    // `open` rather than `fee`: an unpriced type needs no governing organization,
    // which keeps this test about minting rather than about offices.
    const created = await operator.types.create({
      slug,
      name: 'Probe Mintable',
      description: 'Created, declared, minted into and searched.',
      issuerKind: 'either',
      initialStateName: 'active',
      initialStateLabel: 'Active',
      mintPolicy: 'open',
    });
    await operator.types.declareFields(created.typeId, [
      { identifier: 'headline', datatype: 'text', label: 'Headline', required: true },
      { identifier: 'probe_category', datatype: 'text', label: 'Category', folded: true },
    ]);

    await operator.tokens.mint({
      typeId: created.typeId,
      stateName: 'active',
      name: 'A probe record',
      text: { headline: 'A probe record', probe_category: 'Furniture' },
    });

    const hits = await operator.tokens.search(slug, { limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe('A probe record');

    /*
      FOLDED, AND THE NODE FOLDS THE NEEDLE. `probe_category` was declared folded,
      so a MIXED-CASE needle matches a value stored lowercased -- the property a
      directory gets by declaring it and loses silently by forgetting.
    */
    const folded = await operator.tokens.search(slug, {
      text: [{ identifier: 'probe_category', value: 'FURNITURE' }],
      limit: 5,
    });
    expect(folded).toHaveLength(1);

    const fields = await operator.tokens.fields([hits[0]!.tokenId]);
    expect(fields.get(String(hits[0]!.tokenId))?.get('probe_category')?.text).toBe('furniture');
  }, 180_000);
});
