import { beforeAll, describe, expect, it } from 'vitest';

import { BranchClient, fetchChainId, formatAmount, numeric } from '../../src/index.js';

import { OPERATOR_KEY, localWallet } from './local-wallet.js';

/**
 * The credits client against a live node.
 *
 * The point of these is the precision claim. Unit tests can prove the SDK
 * handles a string or a bigint correctly, but not what a real node actually
 * puts on the wire for NUMERIC(78,0) -- and if that arrives as a JS number,
 * every balance past 2^53 is already wrong before any of this code runs.
 */

const PROVIDER = process.env.BRANCH_PROVIDER ?? 'http://127.0.0.1:8484';
const EXPLICIT = process.env.BRANCH_PROVIDER !== undefined;

/**
 * issue_credits takes NUMERIC(78,0), and kwil infers a parameter's type from
 * the JavaScript value -- a string infers as `text` and a number as `int8`, so
 * an undeclared amount is refused outright:
 *
 *   ERROR: type error: action "issue_credits" expected argument 2 to be of
 *   type numeric(78,0), but got text
 *
 * The type has to be stated. There is no JS value that infers to NUMERIC.
 */
const AMOUNT_IS_NUMERIC = { $amount: numeric(78, 0) };

/** 2^53 + 1: the smallest integer a JS number cannot represent. */
const BEYOND_DOUBLE = 9007199254740993n;

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

/** A registered user with no credits yet. */
async function newUser(name: string): Promise<BranchClient> {
  const client = await connect();
  await client.identity.register(name);
  return client;
}

describe('credits client', () => {
  it('reads zero for a registered user who has never been credited', async () => {
    if (!requireNode()) return;
    const user = await newUser('Broke User');

    const balance = await user.credits.balance();
    expect(balance.units).toBe(0n);
    // credits is configured with 0 decimals -- one credit is one dollar.
    expect(balance.decimals).toBe(0);
    expect(formatAmount(balance)).toBe('0');
  }, 60_000);

  it('reads a balance back exactly after issuance', async () => {
    if (!requireNode()) return;
    const user = await newUser('Credited User');
    const operator = await connect(OPERATOR_KEY);

    // Confirms the seeded key really is a registered person before relying on
    // its office; otherwise a bootstrap change shows up as a confusing
    // permission error three lines later.
    await expect(operator.identity.whoami()).resolves.not.toBeNull();

    // issue_credits is office-gated and is not on the credits client on
    // purpose -- it is W5's server-side path, and a method for it would invite
    // the officeholder key into a browser. Driven through the raw write here
    // because the test needs the precondition, not because callers should.
    await operator.write(
      'issue_credits',
      {
        $to_address: user.address,
        $amount: '250',
        $reference: 'integration-test',
      },
      AMOUNT_IS_NUMERIC
    );

    const balance = await user.credits.balance();
    expect(balance.units).toBe(250n);
    expect(formatAmount(balance)).toBe('250');
  }, 90_000);

  /**
   * The assertion this issue exists for.
   *
   * If the node sends NUMERIC(78,0) as a JS number, 2^53+1 comes back as
   * 2^53 and this fails -- which is exactly what should happen, loudly,
   * rather than a user being shown a balance that is off by one credit.
   */
  it('survives an amount past what a JS number can represent', async () => {
    if (!requireNode()) return;
    const user = await newUser('Precision User');
    const operator = await connect(OPERATOR_KEY);

    await operator.write(
      'issue_credits',
      {
        $to_address: user.address,
        $amount: BEYOND_DOUBLE.toString(),
        $reference: 'precision-probe',
      },
      AMOUNT_IS_NUMERIC
    );

    const balance = await user.credits.balance();
    expect(balance.units).toBe(BEYOND_DOUBLE);
    expect(balance.units.toString()).toBe('9007199254740993');
    // The value a double would have given instead.
    expect(balance.units).not.toBe(9007199254740992n);
  }, 90_000);

  /**
   * Credits reach a user as a TRANSFER, not a mint.
   *
   * issue_credits mints against the operator's treasury wallet and then
   * transfers from treasury to the recipient, both under one settlement. So
   * the mint belongs to the treasury holder and never appears in a user's
   * history -- what they see is the movement. This test originally asserted
   * 'mint' and the node corrected it.
   */
  it('lists the issuance on the ledger, as a credit', async () => {
    if (!requireNode()) return;
    const user = await newUser('History User');
    const operator = await connect(OPERATOR_KEY);

    await operator.write(
      'issue_credits',
      {
        $to_address: user.address,
        $amount: '75',
        $reference: 'history-probe',
      },
      AMOUNT_IS_NUMERIC
    );

    const history = await user.credits.history();
    expect(history.length).toBeGreaterThanOrEqual(1);

    const mint = history[0];
    expect(mint).toMatchObject({ kind: 'transfer', direction: 'credit' });
    expect(mint?.amount.units).toBe(75n);
    expect(mint?.occurredAt.getTime()).toBeGreaterThan(0);
    // The treasury's mint is not the user's business and is not in their view.
    expect(history.every((e) => e.kind !== 'mint')).toBe(true);
  }, 90_000);

  it('agrees with the ledger it is a cache of', async () => {
    if (!requireNode()) return;
    const user = await newUser('Reconciling User');
    const operator = await connect(OPERATOR_KEY);

    for (const amount of ['10', '20', '30']) {
      await operator.write(
        'issue_credits',
        {
          $to_address: user.address,
          $amount: amount,
          $reference: 'reconcile',
        },
        AMOUNT_IS_NUMERIC
      );
    }

    // Invariant 4: currency_entries is the source of truth and
    // currency_balances is a cache of it. A statement built from entries and a
    // balance read from the cache must agree, and if they ever do not, the
    // entries are what happened.
    const [balance, history] = await Promise.all([user.credits.balance(), user.credits.history()]);
    const summed = history.reduce(
      (total, entry) =>
        entry.direction === 'credit' ? total + entry.amount.units : total - entry.amount.units,
      0n
    );

    expect(summed).toBe(balance.units);
    expect(balance.units).toBe(60n);
  }, 120_000);
});
