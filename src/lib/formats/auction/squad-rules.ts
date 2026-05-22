// JPL Auction — Squad composition rules.
// Centralised so nominate, auto-nominate, and bid endpoints share one truth.

// Base cap — what the initial auction fills. Slots 16, 17, 18 are locked behind purse-purchases
// (see BONUS_SLOT_PRICES) and only unlockable after the initial auction completes.
export const MAX_SQUAD_SIZE = 15;
// How many extra slots a team can buy past the base cap (slot 16, 17, 18). Absolute cap = 18.
export const MAX_BONUS_SLOTS = 3;
export const ABSOLUTE_SQUAD_CAP = MAX_SQUAD_SIZE + MAX_BONUS_SLOTS;
// Sequential per-slot unlock costs. Index 0 = slot 16 (£10M); 1 = slot 17 (£20M); 2 = slot 18 (£30M).
export const BONUS_SLOT_PRICES = [10_000_000, 20_000_000, 30_000_000] as const;

// element_type → minimum required in final squad
// 1 = GKP, 2 = DEF, 3 = MID, 4 = FWD
export const MIN_QUOTA: Record<number, number> = { 1: 1, 2: 3, 3: 3, 4: 1 };

/**
 * Effective squad cap for a team:
 *   base (14) + bonus unlocks (0-2) − penalty slots (unlimited).
 *
 * The default `bonusSlots = 0` keeps callers that haven't been updated correct for the base case.
 */
export function effectiveMaxSquadSize(penaltySlots: number, bonusSlots: number = 0): number {
  return MAX_SQUAD_SIZE + (bonusSlots ?? 0) - (penaltySlots ?? 0);
}

/** Cost (in purse units) to unlock the next bonus slot, or `null` if all bonus slots are unlocked. */
export function nextBonusSlotCost(bonusSlots: number): number | null {
  const idx = bonusSlots ?? 0;
  if (idx >= MAX_BONUS_SLOTS) return null;
  return BONUS_SLOT_PRICES[idx];
}

export interface SquadCounts {
  1: number;
  2: number;
  3: number;
  4: number;
  total: number;
}

export function emptyCounts(): SquadCounts {
  return { 1: 0, 2: 0, 3: 0, 4: 0, total: 0 };
}

export function countsFromOwnership(
  ownership: { elementType: number | null }[]
): SquadCounts {
  const c = emptyCounts();
  for (const o of ownership) {
    if (o.elementType && (o.elementType === 1 || o.elementType === 2 || o.elementType === 3 || o.elementType === 4)) {
      c[o.elementType as 1 | 2 | 3 | 4]++;
      c.total++;
    } else {
      // Legacy row with no elementType — still counts toward the 14 cap
      c.total++;
    }
  }
  return c;
}

/**
 * Number of players still required to satisfy minimums given current counts.
 */
export function neededForMinimums(counts: SquadCounts): number {
  let need = 0;
  for (const t of [1, 2, 3, 4] as const) {
    need += Math.max(0, MIN_QUOTA[t] - counts[t]);
  }
  return need;
}

/**
 * True when a squad with `counts` and `maxSize` slots can still meet 1/3/3/1.
 * Equivalent to: remainingSlots >= neededForMinimums after adding nothing else.
 */
export function isFeasible(counts: SquadCounts, maxSize: number): boolean {
  const remaining = maxSize - counts.total;
  return remaining >= neededForMinimums(counts);
}

/**
 * Validate that adding a player of the given element_type would (a) not exceed
 * the squad cap and (b) leave the squad able to still meet 1/3/3/1 with the
 * slots that remain.
 *
 * Returns { ok: true } or { ok: false, error: string }.
 */
export function validateAddPlayer(
  counts: SquadCounts,
  penaltySlots: number,
  elementType: number,
  bonusSlots: number = 0,
): { ok: true } | { ok: false; error: string } {
  const maxSize = effectiveMaxSquadSize(penaltySlots, bonusSlots);
  if (counts.total >= maxSize) {
    return { ok: false, error: `Squad is full (${maxSize} players)` };
  }
  if (elementType !== 1 && elementType !== 2 && elementType !== 3 && elementType !== 4) {
    return { ok: false, error: "Unknown player position" };
  }
  const next: SquadCounts = { ...counts, [elementType]: counts[elementType as 1 | 2 | 3 | 4] + 1, total: counts.total + 1 };
  if (!isFeasible(next, maxSize)) {
    const need = neededForMinimums(next);
    const left = maxSize - next.total;
    return {
      ok: false,
      error: `Adding this player leaves ${left} slot(s) but ${need} more are needed to meet 1 GKP / 3 DEF / 3 MID / 1 FWD`,
    };
  }
  return { ok: true };
}
