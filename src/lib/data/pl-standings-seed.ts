// PL Standings seed — tier mapping for the PL Club Auction.
//
// The singleton `pl_standings_config` row (id = "current") is seeded from this constant the first time
// it's needed. Superadmin can override via /superadmin?tab=pl-standings.
//
// FPL bootstrap team IDs are season-specific. At each new PL season, update this file with the new
// IDs (or use the superadmin tab to edit live).
//
// Source for 2025-26 PL season:
//   - Top 8: last season's (2024-25) final-ladder positions 1-8.
//   - Mid (9-17): last season's positions 9-17.
//   - Promoted: the 3 clubs that came up from the Championship for 2025-26
//     (Leeds, Burnley, Sunderland — listed alphabetically).
//
// IDs below are the live 2025-26 FPL bootstrap team IDs (verified against
// fantasy.premierleague.com/api/bootstrap-static/ on 2026-05-18). The bootstrap orders the 20 PL
// clubs by an internal scheme that is NOT pure alphabetical — Burnley=3, Bournemouth=4,
// Brentford=5, Brighton=6 in 2025-26.
// If FPL re-numbers next season, the superadmin tab is the source of truth — re-save the lists there.

import type { ClubTier } from "@/lib/db/schema";

export const PL_STANDINGS_SEED_ID = "current";
export const PL_STANDINGS_SEED_SEASON = "2025-26";

// Top 8 (2024-25 final positions 1-8):
//   Liverpool(12), Arsenal(1), Man City(13), Chelsea(7), Newcastle(15), Aston Villa(2),
//   Nott'm Forest(16), Brighton(6)
export const PL_STANDINGS_SEED_TOP8: number[] = [12, 1, 13, 7, 15, 2, 16, 6];

// Mid (2024-25 final positions 9-17):
//   Bournemouth(4), Brentford(5), Fulham(10), Crystal Palace(8), Everton(9), West Ham(19),
//   Man Utd(14), Wolves(20), Spurs(18)
export const PL_STANDINGS_SEED_MID: number[] = [4, 5, 10, 8, 9, 19, 14, 20, 18];

// Promoted (newly up for 2025-26): Burnley(3), Leeds(11), Sunderland(17) — alphabetical.
export const PL_STANDINGS_SEED_PROMOTED: number[] = [3, 11, 17];

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
