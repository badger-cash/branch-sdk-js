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
