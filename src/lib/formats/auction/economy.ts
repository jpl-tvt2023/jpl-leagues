// JPL Auction Economy Engine
// Handles purse management, weekly payouts, FMV calculation, and switch taxes

/**
 * Weekly GW payout based on rank (in currency units).
 * Ranks 1-10 have fixed payouts; ranks 11+ get a minimum floor.
 */
export const GW_PAYOUTS: Record<number, number> = {
  1: 2_500_000,
  2: 2_100_000,
  3: 1_800_000,
  4: 1_600_000,
  5: 1_400_000,
  6: 1_200_000,
  7: 1_100_000,
  8: 1_000_000,
  9: 900_000,
  10: 800_000,
};

export const MINIMUM_FLOOR_PAYOUT = 500_000;

/**
 * Get the payout amount for a given GW rank.
 * Ranks 1-10 get fixed amounts, 11+ get minimum floor.
 */
export function getPayoutForRank(rank: number): number {
  return GW_PAYOUTS[rank] ?? MINIMUM_FLOOR_PAYOUT;
}

/**
 * Assign competition ranks and payouts to a GW-ordered list of teams.
 *
 * Teams level on GW points share the best rank in their block (1, 1, 3 — the next
 * block skips the places the tie consumed) and split the payouts for every place
 * the block occupies, averaged. Nobody wins £2.5M over an identically-scoring rival
 * because of an arbitrary squad-value difference.
 *
 * `ordered` must already be sorted best-first; the caller's tiebreak still decides
 * row order *within* a tied block, it just no longer decides the money.
 *
 * Centralised because two call sites assign payouts independently (the GW processor
 * and the superadmin score-adjustments PATCH) — if they diverge, an adjustment
 * silently overwrites averaged payouts with strict per-rank ones.
 */
export function assignRanksAndPayouts<T>(
  ordered: T[],
  pointsOf: (item: T) => number
): { item: T; rank: number; payout: number }[] {
  const out: { item: T; rank: number; payout: number }[] = [];

  for (let i = 0; i < ordered.length; ) {
    // Extend the block while the next entry is level on points.
    let end = i + 1;
    while (end < ordered.length && pointsOf(ordered[end]) === pointsOf(ordered[i])) end++;

    const size = end - i;
    const rank = i + 1;
    // Places consumed by this block are rank .. rank + size - 1.
    let pot = 0;
    for (let place = rank; place < rank + size; place++) pot += getPayoutForRank(place);
    // Floor keeps payouts integral and never over-pays the pot.
    const payout = Math.floor(pot / size);

    for (let j = i; j < end; j++) out.push({ item: ordered[j], rank, payout });
    i = end;
  }

  return out;
}

/**
 * Calculate current purse from economic components.
 */
export function calculatePurse(
  initialBudget: number,
  totalIncome: number,
  totalSpent: number,
  totalRefunds: number
): number {
  return initialBudget + totalIncome + totalRefunds - totalSpent;
}

/**
 * Calculate refund for releasing a player (50% of purchase price).
 */
export function calculateRefund(purchasePrice: number): number {
  return Math.floor(purchasePrice * 0.5);
}

/**
 * Calculate Fair Market Value of a player.
 *
 * Reverse-tiered appreciation: players grow slowly when they haven't proven
 * themselves yet, and the per-point rate increases as their season total
 * climbs. This keeps cheap punts cheap (and tradeable) early in the season
 * while still rewarding sustained elite scoring late.
 *
 *   0–100 pts:  £20K / point
 *   100–200 pts: £40K / point
 *   200+ pts:   £60K / point
 */
export function calculateFMV(purchasePrice: number, totalPoints: number): number {
  const pts = Math.max(0, totalPoints);
  const tier1 = Math.min(pts, 100);
  const tier2 = Math.min(Math.max(pts - 100, 0), 100);
  const tier3 = Math.max(pts - 200, 0);
  const appreciation = tier1 * 20_000 + tier2 * 40_000 + tier3 * 60_000;
  return purchasePrice + appreciation;
}

/**
 * Calculate the FMV floor for trades (80% of FMV).
 * Trades must meet or exceed this floor.
 */
export function calculateFMVFloor(purchasePrice: number, totalPoints: number): number {
  return Math.floor(calculateFMV(purchasePrice, totalPoints) * 0.8);
}

/**
 * Switch tax tiers based on season rank.
 * Top-ranked teams pay higher taxes to balance competitiveness.
 *
 * Returns: { pointTax: points deducted from season total, agentFeePercent: % of purchase price }
 */
export function calculateSwitchTax(
  seasonRank: number,
  totalTeams: number
): { pointTax: number; agentFeePercent: number } {
  // Top third
  const topThird = Math.ceil(totalTeams / 3);
  const midThird = Math.ceil((totalTeams * 2) / 3);

  if (seasonRank <= topThird) {
    return { pointTax: 50, agentFeePercent: 15 };
  }
  if (seasonRank <= midThird) {
    return { pointTax: 40, agentFeePercent: 10 };
  }
  // Bottom third
  return { pointTax: 30, agentFeePercent: 5 };
}
