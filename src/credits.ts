import { toUnits } from './amount.js';
import { BranchError } from './errors.js';

import type { CreditAmount } from './amount.js';
import type { BranchClient } from './client.js';

/** How an entry came to exist. Mirrors `currency_entries_kind_vocab`. */
export type CreditEntryKind = 'mint' | 'transfer' | 'burn';

/** One movement on the caller's credit ledger. */
export interface CreditEntry {
  id: bigint;
  kind: CreditEntryKind;
  /** Always positive, as the ledger stores it. Read `direction` for the sign. */
  amount: CreditAmount;
  /** Whether this entry added to the caller's balance or took from it. */
  direction: 'credit' | 'debit';
  /**
   * The entry's own memo, which is a LITERAL rather than anything caller-supplied.
   *
   * `ledger_transfer` writes what the calling action passed it, and the actions
   * pass constants: `credit purchase`, `listing fee`. It says what kind of
   * movement this is, and deliberately not which one.
   */
  memo: string | null;
  /**
   * What the payment was, when there was one. THIS IS THE RECEIPT.
   *
   * `issue_credits` takes a `$reference` -- a PayPal capture id, a bank
   * reference -- and it lands on the SETTLEMENT rather than on the entry, which
   * is a trap worth naming: reading `memo` and expecting a capture id gets the
   * literal `credit purchase` every time, and the mistake is invisible because
   * a string comes back either way.
   *
   * Null for anything that did not come from an off-chain payment. A listing
   * fee has no reference because no money moved outside the ledger.
   */
  reference: string | null;
  /**
   * Why the settlement was opened: `credit issuance`, `paid mint`.
   *
   * THESE ARE THE LITERALS THE CHAIN WRITES, and the second one changed. It was
   * `listing publication` while `create_listing` opened the settlement;
   * badger-cash/branch#74 retired that action and the generic `mint_token` writes
   * `paid mint`, because an action that charges no longer knows it is publishing a
   * classified ad. The old value is not written anywhere any more, so matching on
   * it finds nothing.
   *
   * The envelope's own description, and the only field that says what the
   * movement was FOR. Invariant 15 puts a payment and the thing it paid for in
   * one settlement, so this is the label on that envelope.
   */
  settlementNote: string | null;
  occurredAt: Date;
}

export interface HistoryOptions {
  /** Most recent first. Defaults to 50. */
  limit?: number;
}

interface BalanceRow {
  amount: unknown;
  decimals: unknown;
}

/** One row of `my_credit_history`. The token ledger's shape, not the currency's. */
interface HistoryRow {
  entry_id: unknown;
  kind: unknown;
  direction: unknown;
  quantity: unknown;
  memo: unknown;
  created_at: unknown;
  reference: unknown;
  note: unknown;
}

/**
 * Credit balance and ledger history.
 *
 * Reading only. `issue_credits` is gated on the credit-issuer office and is
 * deliberately not wrapped here -- it is the server-side path in W5, and an
 * SDK method for it would invite the officeholder key into a browser.
 */
export class CreditsClient {
  constructor(private readonly client: BranchClient) {}

  /**
   * What the caller can spend.
   *
   * Served by the `my_credit_balance` action rather than a plain SELECT
   * because it resolves `@caller` through `person_keys` and coalesces a
   * missing balance row to zero -- a registered user who has never been
   * credited has no row in `currency_balances`, which is not the same as an
   * error.
   */
  async balance(): Promise<CreditAmount> {
    const rows = await this.client.read<BalanceRow>('my_credit_balance');
    const row = rows[0];
    if (!row) {
      throw new BranchError('my_credit_balance returned no row');
    }
    return {
      units: toUnits(row.amount, 'balance'),
      decimals: Number(toUnits(row.decimals, 'decimals')),
    };
  }

  /**
   * The caller's ledger entries, most recent first.
   *
   * A plain SELECT rather than an action: decision 2b leaves `SELECT` granted,
   * so read paths need no server-side code. `currency_entries` is the source
   * of truth and `currency_balances` is a cache of it, so a statement built
   * from entries and a balance read from the cache should agree -- and if they
   * ever do not, the entries are what happened.
   */
  async history(options: HistoryOptions = {}): Promise<CreditEntry[]> {
    /*
      THE TOKEN LEDGER, NOT THE CURRENCY LEDGER, and that is a correction rather
      than a refactor. badger-cash/branch#119.

      This queried `currency_entries` for `c.code = 'credits'`. That was right when
      credits were a currency; branch#89 made them a fungible TOKEN, so every
      issuance and every publishing fee is a `token_transfers` row. A seller who had
      bought and spent credits saw a statement missing all of it -- no error, just
      absence, which is the worst shape a money screen can fail in.

      `my_credit_history` resolves the caller and their wallet itself, signs the
      direction from the caller's own side, and resolves the credit token from the
      `credit_token_family` network setting rather than the literal 'credits'.
    */
    const rows = await this.client.read<HistoryRow>('my_credit_history', {
      $limit: options.limit ?? 50,
    });

    // decimals is a property of the token, so one read serves every row.
    const { decimals } = await this.balance();

    return rows.map((row) => ({
      id: toUnits(row.entry_id, 'entry_id'),
      kind: toKind(row.kind),
      amount: { units: toUnits(row.quantity, 'quantity'), decimals },
      /*
        THE ACTION SIGNS IT, not this. It used to be derived here by comparing
        to_holder_id against the caller's own wallet id -- which is the comparison
        a client gets wrong when a wallet appears on both sides of a row, and the
        reason a statement ever shows a debit as a credit. `my_credit_history`
        returns 'in' or 'out' relative to the caller, computed where the caller is
        already known.
      */
      direction: row.direction === 'in' ? ('credit' as const) : ('debit' as const),
      memo: typeof row.memo === 'string' ? row.memo : null,
      reference: typeof row.reference === 'string' ? row.reference : null,
      settlementNote: typeof row.note === 'string' ? row.note : null,
      occurredAt: new Date(Number(toUnits(row.created_at, 'created_at')) * 1000),
    }));
  }
}

function toKind(value: unknown): CreditEntryKind {
  if (value === 'mint' || value === 'transfer' || value === 'burn') return value;
  throw new BranchError(`unrecognised ledger entry kind ${JSON.stringify(value)}`);
}
