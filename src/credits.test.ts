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

async function connect(fixture: Fixture): Promise<{ client: BranchClient; queries: Query[] }> {
  const queries: Query[] = [];
  const kwil: KwilLike = {
    execute(): Promise<{ data?: { tx_hash?: string } }> {
      return Promise.resolve({ data: { tx_hash: '0x00' } });
    },
    call(body): Promise<{ data?: { result?: unknown } }> {
      if (body.name === 'my_credit_balance') {
        return Promise.resolve({
          data: { result: fixture.balance ? [fixture.balance] : [] },
        });
      }
      if (body.name === 'whoami') {
        const me = fixture.whoami;
        return Promise.resolve({ data: { result: me === null ? [] : [me] } });
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
  return { client, queries };
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
  const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 11,
    kind: 'mint',
    amount: '100',
    memo: 'purchase',
    created_at: 1788224916,
    from_holder_id: null,
    to_holder_id: 7,
    ...over,
  });

  it('scopes the query to the caller holder', async () => {
    const { client, queries } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [entry()],
    });

    await client.credits.history();

    expect(queries).toHaveLength(1);
    expect(queries[0]?.params).toMatchObject({ $holder: 7 });
    expect(queries[0]?.sql).toContain('currency_entries');
    // Bound rather than interpolated, and limited by default.
    expect(queries[0]?.sql).toContain('$holder');
    expect(queries[0]?.params.$take).toBe(50);
  });

  it('marks direction relative to the caller', async () => {
    const { client } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [
        entry({ id: 1, to_holder_id: 7, from_holder_id: null }),
        entry({ id: 2, kind: 'transfer', to_holder_id: 9, from_holder_id: 7 }),
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
    expect(queries[0]?.params.$take).toBe(5);
  });

  it('refuses an entry kind the schema could not have produced', async () => {
    const { client } = await connect({
      whoami: ME,
      balance: { amount: '100', decimals: 0 },
      entries: [entry({ kind: 'confiscation' })],
    });
    await expect(client.credits.history()).rejects.toThrow(/unrecognised ledger entry kind/);
  });

  it('refuses a holder id too large to bind without losing precision', async () => {
    // selectQuery cannot declare parameter types, so an INT8 has to go across
    // as a number. Past 2^53 that would match the wrong row rather than fail.
    const { client } = await connect({
      whoami: { ...ME, holder_id: '9007199254740993' },
      balance: { amount: '0', decimals: 0 },
    });
    await expect(client.credits.history()).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });

  it('says so when the key belongs to nobody', async () => {
    const { client } = await connect({ whoami: null, balance: { amount: '0', decimals: 0 } });
    await expect(client.credits.history()).rejects.toThrow(/no person is registered/);
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
    id: 1,
    kind: 'mint',
    amount: '100',
    memo: 'credit purchase',
    created_at: 1757000000,
    from_holder_id: null,
    to_holder_id: 7,
    settlement_reference: null,
    settlement_note: null,
    ...over,
  });

  it('carries the payment reference off the settlement, not the memo', async () => {
    const { client } = await connect({
      balance: { amount: '100', decimals: 0 },
      whoami: ME,
      entries: [entry({ settlement_reference: 'CAPTURE-7X9', settlement_note: 'credit issuance' })],
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
        entry({
          kind: 'transfer',
          memo: 'listing fee',
          to_holder_id: 9,
          from_holder_id: 7,
          settlement_note: 'listing publication',
        }),
      ],
    });
    const [row] = await client.credits.history();
    expect(row?.reference).toBeNull();
    expect(row?.settlementNote).toBe('listing publication');
    expect(row?.direction).toBe('debit');
  });

  it('joins settlements so an entry without one still comes back', async () => {
    // LEFT JOIN, not JOIN: settlement_id is nullable, and an inner join would
    // silently drop those entries from a statement that is meant to be total.
    const { client, queries } = await connect({
      balance: { amount: '100', decimals: 0 },
      whoami: ME,
      entries: [entry({})],
    });
    const [row] = await client.credits.history();
    expect(row?.reference).toBeNull();
    expect(queries.some((q) => /LEFT JOIN settlements/.test(q.sql))).toBe(true);
  });
});
