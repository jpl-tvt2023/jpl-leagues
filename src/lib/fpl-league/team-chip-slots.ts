/**
 * The disclosure rule for a team's TVT chip slots — pure, and deliberately DB-free.
 *
 * This is the part that leaks if it is wrong: /api/fpl-league is public, and a
 * `gameweek_chips` row exists from the moment a chip is DECLARED, well before its deadline.
 * Splitting it out of ./team-stats.ts (which imports the database) is what lets
 * tests/unit/fpl-league-team-stats.test.ts exercise it under `tsx --test` with no league
 * standing up. Same leaf-module discipline as formats/tvt/chip-usage.ts and chip-labels.ts.
 */

import { chipCode, chipName } from "@/lib/formats/tvt/chip-labels";
import { getChipSet } from "@/lib/formats/tvt/chip-set";
import { chipGameweekInSet, chipsUsedInSet, type ChipUsageRow } from "@/lib/formats/tvt/chip-usage";
import { isChipDisclosable, isChipWasted } from "@/lib/formats/tvt/chip-waste";

/** One league-enabled chip in one of the two sets — the unit the team header row renders. */
export interface TeamChipSlot {
  /** Stored code: "D" | "W" | "C" | "SL" | "CB" | "UD". Never render this directly. */
  code: string;
  /** Pill code — "DP" | "WW" | "CC". */
  displayCode: string;
  /** Full name for the tooltip — "Double Pointer". */
  label: string;
  set: 1 | 2;
  /** Spent, counting DISCLOSED rows only: a declaration for an open gameweek reads false. */
  used: boolean;
  /** The gameweek it was spent in; null when unspent OR not yet disclosable. */
  gw: number | null;
  /** Spent but paid nothing. */
  wasted: boolean;
}

/** A `gameweek_chips` row joined to its gameweek — the input the pure pass below works on. */
export interface DisclosableChipInput {
  chipType: string;
  gameweekNumber: number;
  deadlineMs: number;
  isValid: boolean;
  isProcessed: boolean;
  hadNegativeHits: boolean;
  wastedReason: string | null;
}

/**
 * Turn one team's raw chip rows into its slot grid.
 *
 * Pure and DB-free so the disclosure rule — the part that leaks if it is wrong — can be
 * unit-tested without standing a league up. Same leaf-module discipline as chip-usage.ts.
 *
 * Order matters: the deadline gate runs BEFORE `chipsUsedInSet`, because that helper knows
 * nothing about deadlines and filtering after it would already have marked the slot spent.
 */
export function computeTeamChipSlots(
  rows: DisclosableChipInput[],
  enabledChips: string[],
  playoffStartGw: number,
  nowMs: number,
): TeamChipSlot[] {
  const usage: ChipUsageRow[] = [];
  /** `${code}|${set}` -> the row the slot will describe. */
  const wasteByKey = new Map<string, { gw: number; wasted: boolean }>();

  for (const row of rows) {
    if (row.deadlineMs > nowMs) continue; // declared, but not public yet
    if (!isChipDisclosable(row)) continue; // rejected declaration, never played

    usage.push({
      chipType: row.chipType,
      gameweekNumber: row.gameweekNumber,
      isValid: row.isValid,
      isProcessed: row.isProcessed,
    });

    const set = getChipSet(row.gameweekNumber, playoffStartGw);
    if (set === "playoffs") continue; // playoffs have no chip sets
    const key = `${row.chipType}|${set}`;
    const prev = wasteByKey.get(key);
    // Lowest gameweek wins — the same tie-break chipGameweekInSet applies. Anything else and
    // the wasted flag could describe a different row than the gameweek shown beside it.
    if (!prev || row.gameweekNumber < prev.gw) {
      wasteByKey.set(key, { gw: row.gameweekNumber, wasted: isChipWasted(row) });
    }
  }

  const slots: TeamChipSlot[] = [];
  for (const set of [1, 2] as const) {
    const used = chipsUsedInSet(usage, set, playoffStartGw);
    const gws = chipGameweekInSet(usage, set, playoffStartGw);
    for (const code of enabledChips) {
      const isUsed = used.has(code);
      slots.push({
        code,
        displayCode: chipCode(code),
        label: chipName(code),
        set,
        used: isUsed,
        gw: isUsed ? (gws.get(code) ?? null) : null,
        wasted: isUsed && (wasteByKey.get(`${code}|${set}`)?.wasted ?? false),
      });
    }
  }
  return slots;
}

