// JPL Auction — Mini-Auction Logic
// Handles snake order generation and switch cost calculation.
// (Release pricing and the deadwood rule live in ./release-refund.)

import { calculateSwitchTax } from "./economy";

/**
 * Generate snake draft order for mini-auction based on season standings.
 * Bottom-ranked teams pick first (reverse standings order).
 */
export function generateSnakeOrder(
  standings: { teamId: string; rank: number }[]
): string[] {
  // Sort by rank descending (worst team first)
  const sorted = [...standings].sort((a, b) => b.rank - a.rank);
  return sorted.map((s) => s.teamId);
}

/**
 * Calculate the full switch cost for a team acquiring a player in a mini-auction.
 * Combines the purchase price with agent fees and point taxes based on season rank.
 */
export function calculateSwitchCosts(
  purchasePrice: number,
  seasonRank: number,
  totalTeams: number
): { totalCashCost: number; agentFee: number; pointTax: number } {
  const { pointTax, agentFeePercent } = calculateSwitchTax(seasonRank, totalTeams);
  const agentFee = Math.floor(purchasePrice * (agentFeePercent / 100));
  const totalCashCost = purchasePrice + agentFee;

  return { totalCashCost, agentFee, pointTax };
}
