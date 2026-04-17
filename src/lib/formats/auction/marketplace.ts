// JPL Auction — Marketplace / Trade Logic
// Validates trade proposals

import { calculateFMV, calculateFMVFloor } from "./economy";

export interface TradePlayer {
  ownershipId: string;
  fplElementId: number;
  playerName: string;
  purchasePrice: number;
  totalPoints: number; // cumulative season points for FMV calculation
  elementType?: number | null; // 1=GK, 2=DEF, 3=MID, 4=FWD
}

// Minimum players required at each position after any trade
const MIN_POSITIONS: Record<number, number> = { 1: 1, 2: 3, 3: 3, 4: 1 };
const POSITION_NAMES: Record<number, string> = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

/**
 * Build a position count map from a squad array.
 * Only counts players with a known elementType.
 */
export function buildPositionMap(squad: { elementType?: number | null }[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const p of squad) {
    if (p.elementType != null) {
      map.set(p.elementType, (map.get(p.elementType) ?? 0) + 1);
    }
  }
  return map;
}

/**
 * Validate a trade proposal to ensure it meets all rules:
 * 1. Both teams must remain with valid squad sizes (max 14 - penalty slots, min 11)
 * 2. Cash offered must not exceed available purse
 * 3. Trade value must meet the 80% FMV floor
 * 4. Both squads must maintain minimum position quotas after trade
 */
export function validateTradeProposal(
  offeredPlayers: TradePlayer[],
  requestedPlayers: TradePlayer[],
  cashOffered: number, // positive = proposer pays, negative = proposer receives
  proposerSquadSize: number,
  targetSquadSize: number,
  proposerPurse: number,
  targetPurse: number,
  proposerPenaltySlots: number = 0,
  targetPenaltySlots: number = 0,
  proposerPositions?: Map<number, number>, // optional: current position counts for proposer
  targetPositions?: Map<number, number>    // optional: current position counts for target
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Squad size checks after trade
  const proposerAfter = proposerSquadSize - offeredPlayers.length + requestedPlayers.length;
  const targetAfter = targetSquadSize + offeredPlayers.length - requestedPlayers.length;
  const proposerMax = 14 - proposerPenaltySlots;
  const targetMax = 14 - targetPenaltySlots;

  if (proposerAfter > proposerMax) {
    errors.push(`Proposer would exceed ${proposerMax}-player squad limit`);
  }
  if (proposerAfter < 11) {
    errors.push("Proposer would drop below 11-player minimum");
  }
  if (targetAfter > targetMax) {
    errors.push(`Target would exceed ${targetMax}-player squad limit`);
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

  // Position quota checks (only when position data is available)
  if (proposerPositions && targetPositions) {
    // Proposer loses offered players, gains requested players
    const proposerAfterPos = new Map(proposerPositions);
    for (const p of offeredPlayers) {
      if (p.elementType != null) proposerAfterPos.set(p.elementType, (proposerAfterPos.get(p.elementType) ?? 0) - 1);
    }
    for (const p of requestedPlayers) {
      if (p.elementType != null) proposerAfterPos.set(p.elementType, (proposerAfterPos.get(p.elementType) ?? 0) + 1);
    }

    // Target loses requested players, gains offered players
    const targetAfterPos = new Map(targetPositions);
    for (const p of requestedPlayers) {
      if (p.elementType != null) targetAfterPos.set(p.elementType, (targetAfterPos.get(p.elementType) ?? 0) - 1);
    }
    for (const p of offeredPlayers) {
      if (p.elementType != null) targetAfterPos.set(p.elementType, (targetAfterPos.get(p.elementType) ?? 0) + 1);
    }

    for (const [pos, min] of Object.entries(MIN_POSITIONS)) {
      const posNum = Number(pos);
      const name = POSITION_NAMES[posNum];
      const proposerCount = proposerAfterPos.get(posNum) ?? 0;
      const targetCount = targetAfterPos.get(posNum) ?? 0;
      if (proposerCount < min) {
        errors.push(`Proposer would have only ${proposerCount} ${name}(s) — minimum is ${min}`);
      }
      if (targetCount < min) {
        errors.push(`Target would have only ${targetCount} ${name}(s) — minimum is ${min}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

