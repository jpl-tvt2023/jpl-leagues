/**
 * Which chips has a team spent in a given set?
 *
 * The answer lives in `gameweek_chips`, not in the `teams.<chip>Set<N>Used` columns.
 *
 * Those columns were meant to cache it, but nothing on the player's path ever wrote them:
 * POST /api/team/chips inserts the chip row and returns, and the scorer marks the row
 * processed without touching the team. Only the admin override/import routes ever set one
 * to true, and DELETE (cancel) only ever sets one back to false. So for any team that played
 * a chip the ordinary way the columns stayed false for ever — the dashboard kept offering a
 * spent chip as "Available", and the POST guard that reads the same columns kept accepting
 * it, letting one chip be played twice in a set.
 *
 * Deriving from the rows fixes the leagues already carrying that history without a backfill,
 * and removes the cache that could drift again.
 *
 * Pure and import-free so it unit-tests without a database.
 */

import { getChipSet } from "./chip-set";

export interface ChipUsageRow {
  chipType: string;
  gameweekNumber: number;
  isValid: boolean;
  isProcessed: boolean;
}

/**
 * Does this row occupy its set's slot?
 *
 * A live declaration (`isValid`) does, and so does anything the scorer has already run over
 * (`isProcessed`) — a wasted chip is spent, it just paid nothing. The one row that does not
 * is invalid AND unprocessed: a declaration rejected at submission that was never played.
 * Same distinction `isChipDisclosable` draws in ./chip-waste.ts.
 */
function occupiesSlot(row: ChipUsageRow): boolean {
  return row.isValid || row.isProcessed;
}

/**
 * The chip codes ("W", "D", "C", "SL", "CB", "UD") this team has spent in `set`.
 *
 * `set` is the set to report on, normally the one the open submission gameweek falls in.
 * Playoffs have no chip sets, so they always come back empty.
 */
export function chipsUsedInSet(
  rows: ChipUsageRow[],
  set: 1 | 2 | "playoffs",
  playoffStartGw: number,
): Set<string> {
  const used = new Set<string>();
  if (set === "playoffs") return used;

  for (const row of rows) {
    if (!occupiesSlot(row)) continue;
    if (getChipSet(row.gameweekNumber, playoffStartGw) !== set) continue;
    used.add(row.chipType);
  }
  return used;
}

/**
 * The gameweek a chip was spent in, per chip code, for `set` — or null if unspent.
 *
 * Lets a caller render "Used in GW7" from the same rows the used/available state came from,
 * so the badge and the gameweek it names can never disagree.
 */
export function chipGameweekInSet(
  rows: ChipUsageRow[],
  set: 1 | 2 | "playoffs",
  playoffStartGw: number,
): Map<string, number> {
  const gwByChip = new Map<string, number>();
  if (set === "playoffs") return gwByChip;

  for (const row of rows) {
    if (!occupiesSlot(row)) continue;
    if (getChipSet(row.gameweekNumber, playoffStartGw) !== set) continue;
    const existing = gwByChip.get(row.chipType);
    if (existing === undefined || row.gameweekNumber < existing) {
      gwByChip.set(row.chipType, row.gameweekNumber);
    }
  }
  return gwByChip;
}
