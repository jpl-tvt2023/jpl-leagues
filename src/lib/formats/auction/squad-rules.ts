// JPL Auction — Squad composition rules.
// Centralised so nominate, auto-nominate, and bid endpoints share one truth.

export const MAX_SQUAD_SIZE = 14;

// element_type → minimum required in final squad
// 1 = GKP, 2 = DEF, 3 = MID, 4 = FWD
export const MIN_QUOTA: Record<number, number> = { 1: 1, 2: 3, 3: 3, 4: 1 };

export function effectiveMaxSquadSize(penaltySlots: number): number {
  return MAX_SQUAD_SIZE - (penaltySlots ?? 0);
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
  elementType: number
): { ok: true } | { ok: false; error: string } {
  const maxSize = effectiveMaxSquadSize(penaltySlots);
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
