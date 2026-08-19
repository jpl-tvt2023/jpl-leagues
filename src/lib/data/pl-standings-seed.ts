// PL Standings seed — tier mapping for the PL Club Auction.
//
// The singleton `pl_standings_config` row (id = "current") is seeded from this constant the first time
// it's needed. Superadmin can override via /superadmin?tab=pl-standings.
//
// FPL bootstrap team IDs are season-specific. At each new PL season, update this file with the new
// IDs (or use the superadmin tab to edit live).
//
// Source for 2026-27 PL season:
//   - Top 8: last season's (2025-26) final-ladder positions 1-8.
//   - Mid (9-17): last season's positions 9-17.
//   - Promoted: the 3 clubs that came up from the Championship for 2026-27
//     (Coventry, Hull, Ipswich — listed alphabetically).
//
// IDs below are the live 2026-27 FPL bootstrap team IDs (verified against
// fantasy.premierleague.com/api/bootstrap-static/ on 2026-08-19). The bootstrap's ordering scheme
// changes between seasons — 2026-27 is pure alphabetical, 2025-26 was not — so these IDs must be
// re-verified at every season rollover, alongside `PL_FULL_NAMES` in pl-team-full-names.ts.
// If FPL re-numbers next season, the superadmin tab is the source of truth — re-save the lists there.

import type { ClubTier } from "@/lib/db/schema";

export const PL_STANDINGS_SEED_ID = "current";
export const PL_STANDINGS_SEED_SEASON = "2026-27";

// Top 8 (2025-26 final positions 1-8):
//   Arsenal(1), Man City(15), Man Utd(16), Aston Villa(2), Liverpool(14), Bournemouth(3),
//   Sunderland(20), Brighton(5)
export const PL_STANDINGS_SEED_TOP8: number[] = [1, 15, 16, 2, 14, 3, 20, 5];

// Mid (2025-26 final positions 9-17):
//   Brentford(4), Chelsea(6), Crystal Palace(8), Everton(9), Fulham(10), Newcastle(17),
//   Nott'm Forest(18), Spurs(19), Leeds(13)
export const PL_STANDINGS_SEED_MID: number[] = [4, 6, 8, 9, 10, 17, 18, 19, 13];

// Promoted (newly up for 2026-27): Coventry(7), Hull(11), Ipswich(12) — alphabetical.
export const PL_STANDINGS_SEED_PROMOTED: number[] = [7, 11, 12];

/**
 * Resolve a PL team ID to its tier using the standings config.
 * Returns null if the team isn't in any tier list (shouldn't happen for the 20 PL clubs).
 */
export function resolveTier(
  plTeamId: number,
  config: { top8: number[]; mid: number[]; promoted: number[] }
): ClubTier | null {
  if (config.top8.includes(plTeamId)) return "top8";
  if (config.mid.includes(plTeamId)) return "mid";
  if (config.promoted.includes(plTeamId)) return "promoted";
  return null;
}
