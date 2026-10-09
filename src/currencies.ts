import { toUnits } from './amount.js';
import { BranchError } from './errors.js';

import type { CreditAmount } from './amount.js';
import type { BranchClient } from './client.js';

/*
  THE OTHER LEDGER. badger-cash/branch-sdk-js#76.

  A CLIENT OF ITS OWN RATHER THAN A METHOD ON `credits`, deliberately. Credits
  are a fungible TOKEN bought from the site and spent on listings; a currency is
  the USD-equivalent unit held off-chain and debited as gas. They are two
  ledgers -- `token_holdings` and `currency_balances` -- and branch#124 exists
  because the bootstrap had already conflated them once, creating a currency
  called `credits`. Hanging a currency read off the credits client would invite
  the same confusion back in a smaller place.

  ONE METHOD IS ENOUGH TO JUSTIFY IT. `issue_currency` and `transfer_currency`
  are on the chain and will want a home that is not `credits`, and badger-cash/
  branch#137 adds an aggregate that belongs here too.
*/
export class CurrenciesClient {
  constructor(private readonly client: BranchClient) {}

  /**
   * A currency balance for an address.
   *
   * BY CODE, NOT BY ID, and that is forced rather than chosen: there is no
   * public read of `currencies`, so a currency id is as unobtainable from a
   * client as a holder id was. `demo-usd` is the code on a dev or staging chain.
   *
   * WHAT THIS REPLACES: `currency_balance($code, $holder_id)` has been PUBLIC
   * all along and uncallable, because `person_holder_id` was private and nothing
   * else returned a holder id. A public action whose parameters are unreachable
   * is not public. That one is now usable too, for a caller that already holds a
   * holder id -- a group wallet, an admin view -- but an address-holding caller
   * wants this.
   *
   * Unsigned, and the address goes as given: the action folds it with `lower()`.
   * An unknown currency code throws, as does an unregistered address; a
   * registered address with no balance row returns zero, because "never
   * credited" and "spent to nothing" are the same position.
   */
  async balanceOf(address: string, code: string): Promise<CreditAmount> {
    const rows = await this.client.readPublic<{ amount: unknown; decimals: unknown }>(
      'currency_balance_of',
      { $address: address, $code: code }
    );
    const row = rows[0];
    if (!row) {
      throw new BranchError('currency_balance_of returned no row');
    }
    return {
      units: toUnits(row.amount, 'balance'),
      decimals: Number(toUnits(row.decimals, 'decimals')),
    };
  }
}
