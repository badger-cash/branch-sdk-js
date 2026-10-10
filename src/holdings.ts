import { toUnits } from './amount.js';
import { asQueryInt, asText } from './coerce.js';

import type { BranchClient } from './client.js';

/*
  WHAT AN ADDRESS HOLDS, ACROSS TOKEN TYPES. badger-cash/branch-sdk-js#82.

  A CLIENT OF ITS OWN, beside `currencies`, for the same reason: this is not the
  credits client's business. Credits are one fungible token among whatever else
  the network carries, and a directory's records are tokens too -- so a holder's
  set spans types that have nothing to do with each other.

  NOT THE PRIMARY PATH, and the chain's own note says so. At scale a holder may
  carry hundreds or thousands of distinct tokens, so most callers should ask
  about the one they mean -- `credits.balanceOf`, `tokens.holdingOf`,
  `currencies.balanceOf`. This is for a profile or admin view, where the set is
  the answer rather than an obstacle.

  CURRENCIES ARE NOT HERE. `holdings_of` reads `token_holdings`; a currency lives
  in `currency_balances` and is the off-chain-backed unit debited as gas. Two
  ledgers, and branch#124 exists because that conflation already happened once.
  A caller wanting both asks twice, which is honest.
*/

/** One token an address holds. */
export interface Holding {
  readonly tokenId: bigint;
  readonly tokenName: string;
  /** The family slug, so a caller can route to that directory's page. */
  readonly typeSlug: string;
  /**
   * Units held.
   *
   * A bigint, and bare: a token's scale is the token's, which is why `decimals`
   * comes beside it rather than being folded in.
   */
  readonly quantity: bigint;
  readonly isFungible: boolean;
  readonly decimals: number;
}

export class HoldingsClient {
  constructor(private readonly client: BranchClient) {}

  /**
   * One page of what an address holds, lowest token id first.
   *
   * PAGED, AND THE CURSOR IS EXPOSED RATHER THAN HIDDEN. The action caps at 200,
   * and a method that quietly returned a first page is how a profile view lies:
   * a holder with more would be shown a subset indistinguishable from the whole.
   * Pass the last `tokenId` as `after` to continue.
   *
   * AN UNREGISTERED ADDRESS CANNOT BE TOLD FROM ONE HOLDING NOTHING, and that is
   * the transport rather than a choice. The action refuses by name -- but a view
   * action's `ERROR()` does not cross the wire, so a refusal arrives as zero
   * rows, and for a TABLE action zero rows is also a legitimate answer: a
   * registered address genuinely holding nothing. So both resolve to an empty
   * array.
   *
   * The rule is in the README: ask whether zero rows could ever be the truth.
   * Here it can, so unlike `types.states` no refusal can be inferred. A caller
   * needing the difference validates the address with `credits.balanceOf`, which
   * is a single-row action and therefore does throw.
   *
   * A zero-quantity row is excluded by the chain, because a profile listing
   * tokens the holder does not have reads as a bug rather than as history.
   */
  async of(address: string, options: { limit?: number; after?: bigint } = {}): Promise<Holding[]> {
    const rows = await this.client.readPublic<{
      token_id: unknown;
      token_name: unknown;
      type_slug: unknown;
      quantity: unknown;
      is_fungible: unknown;
      decimals: unknown;
    }>('holdings_of', {
      $address: address,
      $limit: options.limit ?? null,
      $after_token_id: options.after === undefined ? null : asQueryInt(options.after),
    });

    return rows.map((row) => ({
      tokenId: toUnits(row.token_id, 'token_id'),
      tokenName: asText(row.token_name, 'token_name'),
      typeSlug: asText(row.type_slug, 'type_slug'),
      quantity: toUnits(row.quantity, 'quantity'),
      isFungible: row.is_fungible === true,
      decimals: Number(toUnits(row.decimals, 'decimals')),
    }));
  }
}
