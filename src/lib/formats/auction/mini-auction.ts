// JPL Auction — Mini-Auction Logic
// Handles release eligibility, snake order generation, and switch cost calculation

import { calculateSwitchTax } from "./economy";

/**
 * Determine if a player is eligible for release in a mini-auction window.
 *
 * - "deadwood" (0 minutes in last 10 GWs OR red-flagged in FPL): unlimited releases
 * - "tactical" (active player): each team gets 1 tactical release per window
 */
export function determineReleaseEligibility(
  ownership: { status: string; fplElementId: number },
  elementStatus: string, // FPL status: "a" (available), "i" (injured), "s" (suspended), "u" (unavailable)
  last10GwMinutes: number // total minutes played in last 10 GWs
): { eligible: boolean; releaseType: "deadwood" | "tactical" | "ineligible"; reason?: string } {
  // Deadwood: zero minutes in last 10 GWs or red-flagged in FPL
  if (last10GwMinutes === 0 || elementStatus === "u" || elementStatus === "s") {
    return { eligible: true, releaseType: "deadwood" };
  }

  // Injured players with minimal minutes could be deadwood
  if (elementStatus === "i" && last10GwMinutes < 30) {
    return { eligible: true, releaseType: "deadwood" };
  }

  // Otherwise, this is a tactical release
  return { eligible: true, releaseType: "tactical" };
}

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
