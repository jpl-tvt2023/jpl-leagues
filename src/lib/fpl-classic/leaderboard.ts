/**
 * FPL Classic — ranking rows into a leaderboard.
 *
 * Two rules that are easy to get wrong:
 *
 *  1. Competition ranking (1, 1, 3 — never 1, 1, 2). Two entrants level on points share a rank,
 *     and the next distinct value skips the ranks their tie consumed. Matches the ranking
 *     `buildFplLeagueStandings` already uses elsewhere in the app, so "rank" means the same thing
 *     on both pages.
 *  2. `topN` truncates by RANK, not by row count. If four entrants are tied for rank 9, all four
 *     make a "top 10" — returning only one of them would misreport who actually won.
 *
 * Sort order beneath the primary metric is deterministic: `tieBreak` (FPL's own overall rank,
 * ascending — lower is better) breaks a tie first, then `name` alphabetically, so two requests
 * for the same data always return rows in the same order.
 *
 * Pure and import-free so it unit-tests without a database.
 */

export interface Rankable {
  entrantId: string;
  value: number;
  /** FPL's own overall rank for this entrant, ascending = better. Null if unknown. */
  tieBreak?: number | null;
  name: string;
}

export type Ranked<T> = T & { rank: number; isTied: boolean };

function compareRankable(a: Rankable, b: Rankable): number {
  if (a.value !== b.value) return b.value - a.value; // higher value first
  const aTie = a.tieBreak ?? Number.POSITIVE_INFINITY;
  const bTie = b.tieBreak ?? Number.POSITIVE_INFINITY;
  if (aTie !== bTie) return aTie - bTie; // lower FPL rank first
  return a.name.localeCompare(b.name);
}

/**
 * Sort and assign competition ranks. Every row is returned, in rank order.
 */
export function rankRows<T extends Rankable>(rows: T[]): Ranked<T>[] {
  const sorted = [...rows].sort(compareRankable);
  const out: Ranked<T>[] = [];

  let currentRank = 0;
  let seen = 0;
  let previousValue: number | null = null;

  for (const row of sorted) {
    seen++;
    if (previousValue === null || row.value !== previousValue) {
      currentRank = seen;
      previousValue = row.value;
    }
    out.push({ ...row, rank: currentRank, isTied: false });
  }

  // A row is tied when it shares its rank with a neighbour — computed after ranks are assigned
  // so a lone entrant at a given value (rank appears once) is correctly NOT marked tied.
  for (let i = 0; i < out.length; i++) {
    const rank = out[i].rank;
    const tiedWithPrev = i > 0 && out[i - 1].rank === rank;
    const tiedWithNext = i < out.length - 1 && out[i + 1].rank === rank;
    out[i].isTied = tiedWithPrev || tiedWithNext;
  }

  return out;
}

/**
 * The top N by rank — not the top N rows. A tie straddling the cut returns every tied row, so a
 * four-way tie for rank 9 in a "top 10" request returns 12 rows, not 10.
 */
export function topN<T extends Rankable>(rows: T[], n: number): Ranked<T>[] {
  const ranked = rankRows(rows);
  return ranked.filter((r) => r.rank <= n);
}
