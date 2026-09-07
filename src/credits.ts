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
   * Why the settlement was opened: `credit issuance`, `listing publication`.
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

interface EntryRow {
  id: unknown;
  kind: unknown;
  amount: unknown;
  memo: unknown;
  created_at: unknown;
  from_holder_id: unknown;
  to_holder_id: unknown;
  settlement_reference: unknown;
  settlement_note: unknown;
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
    const me = await this.client.identity.whoami();
    if (!me) {
      throw new BranchError('no person is registered for this key');
    }

    const limit = options.limit ?? 50;
    const rows = await this.client.query<EntryRow>(
      `SELECT e.id, e.kind, e.amount, e.memo, e.created_at,
              e.from_holder_id, e.to_holder_id,
              s.reference AS settlement_reference,
              s.note      AS settlement_note
         FROM currency_entries e
         JOIN currencies c ON c.id = e.currency_id
         LEFT JOIN settlements s ON s.id = e.settlement_id
        WHERE c.code = 'credits'
          AND (e.to_holder_id = $holder OR e.from_holder_id = $holder)
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $take`,
      { $holder: asQueryInt(me.holderId, 'holderId'), $take: limit }
    );

    // decimals is a property of the currency, so one read serves every row.
    const { decimals } = await this.balance();

    return rows.map((row) => {
      const toHolder = row.to_holder_id === null ? null : toUnits(row.to_holder_id, 'to_holder_id');
      return {
        id: toUnits(row.id, 'id'),
        kind: toKind(row.kind),
        amount: { units: toUnits(row.amount, 'amount'), decimals },
        direction: toHolder !== null && toHolder === me.holderId ? 'credit' : 'debit',
        memo: typeof row.memo === 'string' ? row.memo : null,
        reference: typeof row.settlement_reference === 'string' ? row.settlement_reference : null,
        settlementNote: typeof row.settlement_note === 'string' ? row.settlement_note : null,
        occurredAt: new Date(Number(toUnits(row.created_at, 'created_at')) * 1000),
      };
    });
  }
}

/**
 * An INT8 bound into a plain SELECT, as a number, checked first.
 *
 * `selectQuery` has no way to declare a parameter's type -- unlike `execute`,
 * which takes a `types` map -- so kwil infers it from the JavaScript value and
 * every alternative is worse. A bigint is refused outright ("Unsupported type:
 * bigint"). A string infers as `text`, and the planner will not compare that
 * to an int8 column ("operator does not exist: bigint = text"); writing
 * `$holder::int8` in the SQL does not help, because the cast is lost before
 * Postgres sees the statement.
 *
 * That leaves a number, which is fine for every id a counter will realistically
 * allocate and wrong past 2^53. So it is checked rather than assumed: an id
 * that large throws here instead of quietly matching the wrong row.
 */
function asQueryInt(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BranchError(
      `${field} is ${value.toString()}, which is past Number.MAX_SAFE_INTEGER and cannot be ` +
        'bound into a plain SELECT without losing precision'
    );
  }
  return Number(value);
}

function toKind(value: unknown): CreditEntryKind {
  if (value === 'mint' || value === 'transfer' || value === 'burn') return value;
  throw new BranchError(`unrecognised ledger entry kind ${JSON.stringify(value)}`);
}
