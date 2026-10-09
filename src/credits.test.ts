import { describe, expect, it } from 'vitest';

import { AmountPrecisionError } from './amount.js';
import { BranchClient } from './client.js';

import type { KwilLike } from './client.js';

const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

interface Fixture {
  balance?: { amount: unknown; decimals: unknown };
  whoami?: { person_id: unknown; handle: string; display_name: string; holder_id: unknown } | null;
  entries?: Record<string, unknown>[];
}

interface Query {
  sql: string;
  params: Record<string, unknown>;
}

interface Called {
  name: string;
  /*
    `| undefined` explicitly, because exactOptionalPropertyTypes is on: an
    optional property and one that may hold undefined are different types here,
    and a recorded call genuinely may have had no inputs.
  */
  inputs: Record<string, unknown> | undefined;
}

async function connect(
  fixture: Fixture
): Promise<{ client: BranchClient; queries: Query[]; calls: Called[] }> {
  const queries: Query[] = [];
  // Recorded so a test can assert the SHAPE of a call -- which action, with
  // which inputs -- as the tokenTypes suite does.
  const calls: Called[] = [];
  const kwil: KwilLike = {
    execute(): Promise<{ data?: { tx_hash?: string } }> {
      return Promise.resolve({ data: { tx_hash: '0x00' } });
    },
    call(body): Promise<{ data?: { result?: unknown } }> {
      calls.push({ name: body.name, inputs: body.inputs });
      if (body.name === 'my_credit_balance' || body.name === 'credit_balance_of') {
        return Promise.resolve({
          data: { result: fixture.balance ? [fixture.balance] : [] },
        });
      }
      if (body.name === 'whoami') {
        const me = fixture.whoami;
        return Promise.resolve({ data: { result: me === null ? [] : [me] } });
      }
      /*
        THE STATEMENT IS AN ACTION NOW, AND AGAINST THE TOKEN LEDGER.
        badger-cash/branch#119: `history` read `currency_entries` directly, which
        stopped being where credits move when #89 made them a fungible token.
        `my_credit_history` resolves the caller, signs the direction from the
        caller's own side, and finds the credit token through the
        `credit_token_family` network setting.
      */
      if (body.name === 'my_credit_history') {
        queries.push({ sql: body.name, params: body.inputs });
        return Promise.resolve({ data: { result: fixture.entries ?? [] } });
      }
      return Promise.resolve({ data: { result: [] } });
    },
    selectQuery<T extends object>(
      query: string,
      params?: Record<string, unknown>
    ): Promise<{ data?: T[] }> {
      queries.push({ sql: query, params: params ?? {} });
      return Promise.resolve({ data: (fixture.entries ?? []) as T[] });
    },
  };

  const client = await BranchClient.connect({
    provider: 'http://example.invalid',
    chainId: 'kwil-testnet',
    address: ADDRESS,
    signer: { signMessage: () => Promise.resolve('0x00') },
    kwil,
  });
  return { client, queries, calls };
}

const ME = { person_id: 4, handle: 'u-abc', display_name: 'Ada', holder_id: 7 };

describe('balance', () => {
  it('reads the amount and the currency decimals', async () => {
    const { client } = await connect({ balance: { amount: '250', decimals: 0 } });
    await expect(client.credits.balance()).resolves.toEqual({ units: 250n, decimals: 0 });
  });

  it('is zero for a registered user who has never been credited', async () => {
    // my_credit_balance coalesces the missing currency_balances row, which is
    // not the same as an error and should not read as one.
    const { client } = await connect({ balance: { amount: 0, decimals: 0 } });
    await expect(client.credits.balance()).resolves.toEqual({ units: 0n, decimals: 0 });
  });

  it('reads a balance for an address that is not the caller', async () => {
    const { client, calls } = await connect({ balance: { amount: 42, decimals: 0 } });
    await expect(client.credits.balanceOf('0xAbC')).resolves.toEqual({
      units: 42n,
      decimals: 0,
    });
    const call = calls.find((c: { name: string }) => c.name === 'credit_balance_of');
    expect(call).toBeDefined();
    // THE ADDRESS GOES AS GIVEN. The action folds it with lower(); folding here
    // would move the rule into every caller and hide it from this test.
    expect(call?.inputs?.$address).toBe('0xAbC');
  });

  it('throws when the chain refuses an address, rather than reading zero', async () => {
    /*
      A refused view action answers zero rows -- its ERROR() does not cross the
      wire -- and for a single-row action zero rows can only be a refusal. So
      this throws, with the SDK's message rather than the chain's.
    */
    // No balance fixture at all: the fake answers zero rows, which is what a
    // refused view action looks like on the wire.
    const { client } = await connect({});
    await expect(client.credits.balanceOf('0xNope')).rejects.toThrow(/returned no row/);
  });

  it('carries a balance no JS number could hold', async () => {
    const huge = '9'.repeat(40);
    const { client } = await connect({ balance: { amount: huge, decimals: 0 } });
    const balance = await client.credits.balance();
    expect(balance.units).toBe(BigInt(huge));
  });

  it('refuses a balance that arrived already rounded', async () => {
    const { client } = await connect({ balance: { amount: 1e30, decimals: 0 } });
    await expect(client.credits.balance()).rejects.toThrow(AmountPrecisionError);
  });
});

describe('history', () => {
  /*
    THE TOKEN LEDGER'S SHAPE, not the currency ledger's. `my_credit_history`
    returns entry_id/quantity/direction/reference/note, and signs the direction
    itself -- so a fixture no longer carries holder ids for the client to compare.
  */
  const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    entry_id: 11,
    kind: 'mint',
    direction: 'in',
    quantity: '100',
    memo: 'purchase',
    created_at: 1788224916,
    reference: null,
    note: null,
    ...over,
  });

  it('scopes the query to the caller holder', async () => {
    const { client, queries } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [entry()],
    });

    await client.credits.history();

    /*
      THE ACTION SCOPES IT, not this client. It used to bind $holder into a SELECT,
      which meant the client resolved the caller's wallet and carried the
      address-normalisation rule. `my_credit_history` does both, so what is left to
      assert is that the right action was called with the right limit.
    */
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toBe('my_credit_history');
    expect(queries[0]?.params.$limit).toBe(50);
  });

  it('marks direction relative to the caller', async () => {
    const { client } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [
        entry({ entry_id: 1, direction: 'in' }),
        entry({ entry_id: 2, kind: 'transfer', direction: 'out' }),
      ],
    });

    const history = await client.credits.history();
    expect(history[0]).toMatchObject({ id: 1n, direction: 'credit', kind: 'mint' });
    expect(history[1]).toMatchObject({ id: 2n, direction: 'debit', kind: 'transfer' });
    // The ledger stores amounts positive; the sign lives in `direction`.
    expect(history[1]?.amount.units).toBe(100n);
  });

  it('maps memo and timestamp', async () => {
    const { client } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [entry({ memo: null })],
    });
    const [first] = await client.credits.history();
    expect(first?.memo).toBeNull();
    expect(first?.occurredAt.getTime()).toBe(1788224916 * 1000);
  });

  it('honours a limit', async () => {
    const { client, queries } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [],
    });
    await client.credits.history({ limit: 5 });
    expect(queries[0]?.params.$limit).toBe(5);
  });

  it('refuses an entry kind the schema could not have produced', async () => {
    const { client } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [entry({ kind: 'confiscation' })],
    });
    await expect(client.credits.history()).rejects.toThrow(/unrecognised ledger entry kind/);
  });

  /*
    TWO CONCERNS LEFT THIS CLIENT ENTIRELY, and deleting their tests is the honest
    record of that rather than a gap. badger-cash/branch#119.

    A HOLDER ID TOO LARGE TO BIND. `history` used to resolve the caller's wallet
    and bind it into a SELECT as a number, because selectQuery cannot declare
    parameter types -- so past 2^53 it would have matched the WRONG ROW rather than
    failed, and a guard threw instead. `my_credit_history` resolves the wallet on
    chain from @caller and no id crosses the wire, so there is no longer a
    precision boundary to guard. The guard and its test are gone, not relaxed.

    AN UNREGISTERED KEY. This pre-flighted `whoami` to get that wallet and raised
    "no person is registered" itself. The action resolves the caller and refuses by
    name -- "unknown signer: no active key registered for 0x..." -- so the
    pre-flight is one round trip that bought a slightly different sentence. The
    refusal is covered where it now lives: tests/integration/credits.node.test.ts,
    against a node, which is the only place a signer's registration state is real.
  */
  it('asks the chain for the statement without pre-flighting whoami', async () => {
    const { client, queries } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [],
    });
    await client.credits.history();
    // One read, and it is the statement. Not two.
    expect(queries.map((q) => q.sql)).toEqual(['my_credit_history']);
  });
});

/*
  The settlement fields, which exist because `memo` looks like it carries the
  payment reference and does not. These pin the mapping; whether the LEFT JOIN
  is one the node accepts is verified against a running node, because a stub
  answers whatever it is asked.
*/
describe('statement references', () => {
  const entry = (over: Record<string, unknown>) => ({
    entry_id: 1,
    kind: 'mint',
    direction: 'in',
    quantity: '100',
    memo: 'credit purchase',
    created_at: 1757000000,
    reference: null,
    note: null,
    ...over,
  });

  it('carries the payment reference off the settlement, not the memo', async () => {
    const { client } = await connect({
      balance: { amount: '100', decimals: 0 },
      whoami: ME,
      entries: [entry({ reference: 'CAPTURE-7X9', note: 'credit issuance' })],
    });
    const [row] = await client.credits.history();
    // The trap: memo is the literal, and reading it for a capture id succeeds
    // silently with the wrong string.
    expect(row?.memo).toBe('credit purchase');
    expect(row?.reference).toBe('CAPTURE-7X9');
    expect(row?.settlementNote).toBe('credit issuance');
  });

  it('leaves the reference null when no money moved off-chain', async () => {
    const { client } = await connect({
      balance: { amount: '100', decimals: 0 },
      whoami: ME,
      entries: [
        // 'out', because the action signs the direction from the caller's side.
        // The client no longer compares holder ids to work it out.
        entry({
          kind: 'transfer',
          direction: 'out',
          memo: 'listing fee',
          note: 'paid mint',
        }),
      ],
    });
    const [row] = await client.credits.history();
    expect(row?.reference).toBeNull();
    expect(row?.settlementNote).toBe('paid mint');
    expect(row?.direction).toBe('debit');
  });

  it('returns an entry that has no settlement at all', async () => {
    /*
      THE LEFT JOIN MOVED INTO THE ACTION, so what is checked here is the
      consequence rather than the SQL: an entry with no settlement still comes
      back, with a null reference. A fee transfer between two on-chain wallets
      legitimately has none, and an inner join would silently drop those from a
      statement that is meant to be total.

      That the join really is LEFT is proven against a node in
      tests/integration/credits.node.test.ts. Asserting the word here only ever
      checked that the string was still in the file.
    */
    const { client } = await connect({
      balance: { amount: '100', decimals: 0 },
      whoami: ME,
      entries: [entry({})],
    });
    const rows = await client.credits.history();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reference).toBeNull();
    expect(rows[0]?.settlementNote).toBeNull();
  });
});
