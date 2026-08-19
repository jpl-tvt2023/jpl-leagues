// Full official PL club names.
//
// FPL's bootstrap ships only the short broadcaster form (e.g. "West Ham", "Nott'm Forest", "Spurs",
// "Man Utd") — there's no longer-name field. Premier League branding uses the canonical full names
// ("West Ham United", "Nottingham Forest", "Tottenham Hotspur", "Manchester United"). We surface the
// full form everywhere a club is displayed; the short form stays available via `plTeamShort` for
// dense surfaces.
//
// The PRIMARY lookup is keyed by FPL `short_name` ("MCI", "COV") because that code is stable for a
// club across seasons. FPL's numeric team `id` is NOT stable — it is reassigned every season as
// promoted clubs swap in, and the id-keyed map below silently returned a *different club's* name
// after the 2026-27 renumber (a team that bought Man City displayed as "Newcastle United"). The id
// map is kept only as a fallback for rows with no stored short.
//
// When a promoted club arrives, add its short code below. A club that is missing from the map falls
// back to the FPL short form ("Man City") — wrong in style but never wrong in identity.

/** Primary lookup: FPL `short_name` → full club name. Stable across seasons. */
export const PL_FULL_NAMES_BY_SHORT: Record<string, string> = {
  ARS: "Arsenal",
  AVL: "Aston Villa",
  BOU: "Bournemouth",
  BRE: "Brentford",
  BHA: "Brighton and Hove Albion",
  BUR: "Burnley",
  CHE: "Chelsea",
  COV: "Coventry City",
  CRY: "Crystal Palace",
  EVE: "Everton",
  FUL: "Fulham",
  HUL: "Hull City",
  IPS: "Ipswich Town",
  LEE: "Leeds United",
  LEI: "Leicester City",
  LIV: "Liverpool",
  MCI: "Manchester City",
  MUN: "Manchester United",
  NEW: "Newcastle United",
  NFO: "Nottingham Forest",
  SHU: "Sheffield United",
  SOU: "Southampton",
  SUN: "Sunderland",
  TOT: "Tottenham Hotspur",
  WHU: "West Ham United",
  WOL: "Wolverhampton Wanderers",
};

/**
 * Fallback lookup: FPL bootstrap team ID → full club name.
 *
 * SEASON-SCOPED — only valid for the season noted here. Used when a stored row has no `plTeamShort`
 * (e.g. an ownership row written while the FPL bootstrap fetch was failing). Prefer the short-keyed
 * map above.
 *
 * IDs below are the live 2026-27 FPL bootstrap team IDs (verified against
 * fantasy.premierleague.com/api/bootstrap-static/ on 2026-08-19). 2026-27 happens to be pure
 * alphabetical order; earlier seasons were not, so do not assume that holds.
 */
export const PL_FULL_NAMES: Record<number, string> = {
  1:  "Arsenal",
  2:  "Aston Villa",
  3:  "Bournemouth",
  4:  "Brentford",
  5:  "Brighton and Hove Albion",
  6:  "Chelsea",
  7:  "Coventry City",
  8:  "Crystal Palace",
  9:  "Everton",
  10: "Fulham",
  11: "Hull City",
  12: "Ipswich Town",
  13: "Leeds United",
  14: "Liverpool",
  15: "Manchester City",
  16: "Manchester United",
  17: "Newcastle United",
  18: "Nottingham Forest",
  19: "Tottenham Hotspur",
  20: "Sunderland",
};

/**
 * Returns the full PL club name.
 *
 * Resolution order:
 *   1. `plTeamShort` against the season-stable short map — the reliable path.
 *   2. `plTeamId` against the season-scoped ID map — only right for the season that map describes.
 *   3. `fallback` (the stored/bootstrap short form) — never the wrong club, just the short style.
 */
export function getPlTeamFullName(
  plTeamId: number,
  fallback: string,
  plTeamShort?: string | null,
): string {
  if (plTeamShort) {
    const byShort = PL_FULL_NAMES_BY_SHORT[plTeamShort.toUpperCase()];
    if (byShort) return byShort;
  }
  return PL_FULL_NAMES[plTeamId] ?? fallback;
}
