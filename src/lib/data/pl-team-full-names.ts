// Full official PL club names, keyed by FPL bootstrap team ID.
//
// FPL's bootstrap ships only the short broadcaster form (e.g. "West Ham", "Nott'm Forest", "Spurs",
// "Man Utd") — there's no longer-name field. Premier League branding uses the canonical full names
// ("West Ham United", "Nottingham Forest", "Tottenham Hotspur", "Manchester United"). We surface the
// full form everywhere a club is displayed; the short form stays available via `plTeamShort` for
// dense surfaces.
//
// Updated alongside the seed in `pl-standings-seed.ts` when FPL renumbers (typically each new PL
// season when 3 promoted clubs swap in).

export const PL_FULL_NAMES: Record<number, string> = {
  1:  "Arsenal",
  2:  "Aston Villa",
  3:  "Burnley",
  4:  "Bournemouth",
  5:  "Brentford",
  6:  "Brighton and Hove Albion",
  7:  "Chelsea",
  8:  "Crystal Palace",
  9:  "Everton",
  10: "Fulham",
  11: "Leeds United",
  12: "Liverpool",
  13: "Manchester City",
  14: "Manchester United",
  15: "Newcastle United",
  16: "Nottingham Forest",
  17: "Sunderland",
  18: "Tottenham Hotspur",
  19: "West Ham United",
  20: "Wolverhampton Wanderers",
};

/**
 * Returns the full PL team name for the given FPL ID, falling back to the supplied short form if
 * the ID isn't in the map (FPL renumbering / unknown team — fail safe rather than render undefined).
 */
export function getPlTeamFullName(plTeamId: number, fallback: string): string {
  return PL_FULL_NAMES[plTeamId] ?? fallback;
}
