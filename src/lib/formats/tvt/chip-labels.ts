/**
 * TVT chip display labels — stored code -> what the UI shows.
 *
 * Two distinct things, deliberately kept together so they cannot drift apart:
 *
 *   - `TVT_CHIP_CODES`  the SHORT form shown on pills ("DP", "CC", "WW")
 *   - `TVT_CHIP_NAMES`  the LONG form shown in tooltips and prose ("Double Pointer")
 *
 * Note the stored value is NOT the display code: the DB holds `D`, the user-facing
 * code is `DP`. Rendering `chipType` directly is a bug — the Captains & Chips panel
 * used to show "D: Double Pointer" for exactly that reason.
 *
 * This module deliberately has NO imports. The dashboard is a client component and
 * the neighbouring chip-validation.ts pulls in the DB, so the codes had nowhere
 * client-safe to live and got copied instead. Same leaf-module shape as ./tiebreaker.ts.
 */

/** Stored chip type -> the short code shown on a pill. */
export const TVT_CHIP_CODES: Record<string, string> = {
  D: "DP",
  C: "CC",
  W: "WW",
  SL: "SL",
  CB: "CB",
  UD: "UD",
};

/** Stored chip type -> the full human-readable chip name. */
export const TVT_CHIP_NAMES: Record<string, string> = {
  W: "Win-Win",
  D: "Double Pointer",
  C: "Challenge Chip",
  SL: "Score Lock",
  CB: "Comeback",
  UD: "Underdog",
};

/** Short pill code for a stored chip type; falls back to the raw value. */
export function chipCode(chipType: string): string {
  return TVT_CHIP_CODES[chipType] ?? chipType;
}

/** Full chip name for a stored chip type; falls back to the raw value. */
export function chipName(chipType: string): string {
  return TVT_CHIP_NAMES[chipType] ?? chipType;
}

/**
 * The chips the scoring engine actually processes today.
 *
 * A league may enable any three of the six codes above, but only these are handled in
 * api/gameweeks/[gw] (W and D inline, C in the challenge pass). Score Lock, Comeback and
 * Underdog exist as enable-able codes, teams columns and import parsing, and score nothing
 * — so a team that played one would burn its slot for no points.
 *
 * Offering a chip is therefore gated on this, not just on the league's enabledChips. Delete
 * a code from here the moment the scorer learns to process it.
 */
export const IMPLEMENTED_TVT_CHIPS: readonly string[] = ["W", "D", "C"];

/** Does the scoring engine process this chip? */
export function isChipImplemented(chipType: string): boolean {
  return IMPLEMENTED_TVT_CHIPS.includes(chipType);
}
