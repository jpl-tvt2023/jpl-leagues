// JPL Auction — Marketplace / Trade Logic
// Validates trade proposals and handles veto voting

import { calculateFMV, calculateFMVFloor } from "./economy";

export interface TradePlayer {
  ownershipId: string;
  fplElementId: number;
  playerName: string;
  purchasePrice: number;
  totalPoints: number; // cumulative season points for FMV calculation
}

/**
 * Validate a trade proposal to ensure it meets all rules:
 * 1. Both teams must remain with valid squad sizes (max 14, min 11)
 * 2. Cash offered must not exceed available purse
 * 3. Trade value must meet the 80% FMV floor
 */
export function validateTradeProposal(
  offeredPlayers: TradePlayer[],
  requestedPlayers: TradePlayer[],
  cashOffered: number, // positive = proposer pays, negative = proposer receives
  proposerSquadSize: number,
  targetSquadSize: number,
  proposerPurse: number,
  targetPurse: number
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Squad size checks after trade
  const proposerAfter = proposerSquadSize - offeredPlayers.length + requestedPlayers.length;
  const targetAfter = targetSquadSize + offeredPlayers.length - requestedPlayers.length;

  if (proposerAfter > 14) {
    errors.push("Proposer would exceed 14-player squad limit");
  }
  if (proposerAfter < 11) {
    errors.push("Proposer would drop below 11-player minimum");
  }
  if (targetAfter > 14) {
    errors.push("Target would exceed 14-player squad limit");
  }
  if (targetAfter < 11) {
    errors.push("Target would drop below 11-player minimum");
  }

  // Cash check
  if (cashOffered > 0 && cashOffered > proposerPurse) {
    errors.push("Proposer does not have enough purse for the cash offered");
  }
  if (cashOffered < 0 && Math.abs(cashOffered) > targetPurse) {
    errors.push("Target does not have enough purse for the cash requested");
  }

  // FMV floor enforcement: total value given must be >= 80% of total value received
  // For each side: sum of (player FMVs + cash)
  const offeredFMV = offeredPlayers.reduce(
    (sum, p) => sum + calculateFMV(p.purchasePrice, p.totalPoints),
    0
  );
  const requestedFMV = requestedPlayers.reduce(
    (sum, p) => sum + calculateFMV(p.purchasePrice, p.totalPoints),
    0
  );

  // Proposer gives: offered players + cash (if positive)
  const proposerGivesValue = offeredFMV + Math.max(0, cashOffered);
  // Target gives: requested players + cash (if negative, target pays)
  const targetGivesValue = requestedFMV + Math.max(0, -cashOffered);

  // Each side must give at least 80% of what they receive
  const proposerFloor = Math.floor(targetGivesValue * 0.8);
  const targetFloor = Math.floor(proposerGivesValue * 0.8);

  if (proposerGivesValue < proposerFloor) {
    errors.push(
      `Trade undervalues what proposer gives. Minimum value: ${proposerFloor.toLocaleString()}, offered: ${proposerGivesValue.toLocaleString()}`
    );
  }
  if (targetGivesValue < targetFloor) {
    errors.push(
      `Trade undervalues what target gives. Minimum value: ${targetFloor.toLocaleString()}, offered: ${targetGivesValue.toLocaleString()}`
    );
  }

  // Must trade at least 1 player
  if (offeredPlayers.length === 0 && requestedPlayers.length === 0) {
    errors.push("Trade must involve at least one player");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check if a trade veto has passed (majority of non-involved teams voted to veto).
 * Returns the veto result.
 */
export function checkVetoResult(
  vetoVotes: Record<string, "veto" | "approve">,
  totalTeams: number,
  proposerTeamId: string,
  targetTeamId: string
): { decided: boolean; vetoed: boolean; vetoCount: number; approveCount: number; required: number } {
  // Only non-involved teams can vote
  const eligibleVoters = totalTeams - 2;
  const requiredForVeto = Math.ceil(eligibleVoters / 2); // simple majority

  let vetoCount = 0;
  let approveCount = 0;

  for (const [teamId, vote] of Object.entries(vetoVotes)) {
    if (teamId === proposerTeamId || teamId === targetTeamId) continue;
    if (vote === "veto") vetoCount++;
    else if (vote === "approve") approveCount++;
  }

  // Decided if majority veto OR enough approvals that veto is impossible
  const decided = vetoCount >= requiredForVeto || approveCount > eligibleVoters - requiredForVeto;

  return {
    decided,
    vetoed: vetoCount >= requiredForVeto,
    vetoCount,
    approveCount,
    required: requiredForVeto,
  };
}
