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
 * FMV = PurchasePrice + (TotalPoints * 50,000)
 */
export function calculateFMV(purchasePrice: number, totalPoints: number): number {
  return purchasePrice + totalPoints * 50_000;
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
