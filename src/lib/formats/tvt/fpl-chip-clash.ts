/**
 * TVT chip vs FPL chip — the clash rule.
 *
 * League rule: a team's TVT chip is WASTED if either of its two managers played any official FPL
 * chip (Wildcard, Bench Boost, Triple Captain, Free Hit, Assistant Manager) in the same gameweek.
 * The TVT chip still counts as spent; it simply awards nothing.
 *
 * The rule is team-wide, not per-manager: one manager burning a Wildcard voids the team's chip
 * even though the other manager did nothing. Callers therefore pass BOTH managers' statuses and
 * this module never sees which is which.
 *
 * ⚠️ Missing data is not evidence. `FplChipStatus` is read from the entry-history cache, and a
 * null status means "we could not read that manager's history", not "that manager played nothing".
 * Nulls are ignored here, and a side whose statuses are all null yields NO clash — a chip wrongly
 * voided costs a team real league points, whereas a chip wrongly honoured can be corrected with
 * the admin override that already exists.
 *
 * Pure so it unit-tests without a database. The one import is type-only at runtime:
 * fpl-league/chips.ts has no runtime imports of its own.
 */

import { FPL_CHIP_LABELS, type FplChipStatus } from "@/lib/fpl-league/chips";

/**
 * Which FPL chips a team's managers played in one gameweek.
 *
 * Returns display codes ("BB", "TC", "WC1"…), deduplicated and stable-ordered, so the reason
 * string reads the same however the statuses arrived. Null/undefined statuses are skipped.
 */
export function fplChipsPlayedInGw(
  statuses: (FplChipStatus | null | undefined)[],
  gwNumber: number,
): string[] {
  const codes = new Set<string>();
  for (const status of statuses) {
    if (!status) continue;
    for (const chip of status.used) {
      if (chip.gw === gwNumber) codes.add(chip.code);
    }
  }
  return [...codes].sort();
}

/** Human name for a chip code, falling back to the raw code for a chip FPL added mid-season. */
function labelFor(code: string): string {
  return FPL_CHIP_LABELS[code] ?? code;
}

/**
 * The reason to persist and display, or null when there is no clash.
 *
 * Named chips rather than a generic "an FPL chip was played": a team told which chip cost them
 * their Double Pointer can check it against their own FPL history, and one told nothing cannot.
 */
export function tvtChipWasteReason(
  fplCodesPlayed: string[],
  tvtChipName: string,
): string | null {
  if (fplCodesPlayed.length === 0) return null;
  const named = fplCodesPlayed.map(labelFor).join(" + ");
  return `${tvtChipName} wasted — ${named} played the same gameweek`;
}

/**
 * Convenience for callers holding statuses rather than codes. Same rules; returns null when
 * there is no clash or when nothing could be read.
 */
export function tvtChipWasteReasonFor(
  statuses: (FplChipStatus | null | undefined)[],
  gwNumber: number,
  tvtChipName: string,
): string | null {
  return tvtChipWasteReason(fplChipsPlayedInGw(statuses, gwNumber), tvtChipName);
}
