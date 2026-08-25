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
