// Team display-name helper for the PL Club Auction.
//
// When a fantasy team owns a PL club, the team displays as the club's name everywhere
// (Standings, GW Results, Squad, Teams page, Marketplace, etc.). The original `teams.name`
// is preserved in the DB — only the display layer overlays the club name.

import type { ClubTier } from "@/lib/db/schema";

export type TeamClubOwnership = {
  plTeamId: number;
  plTeamName: string;
  plTeamShort: string;
  tier: ClubTier;
};

export type TeamLike = { id: string; name: string };

/**
 * Return the display name for a fantasy team. If the team owns a PL club, returns the club's name
 * (e.g. "Liverpool"); otherwise returns the original team name.
 */
export function getTeamDisplayName(team: TeamLike, ownership?: TeamClubOwnership | null): string {
  return ownership?.plTeamName ?? team.name;
}

/**
 * Return the short identifier for a fantasy team. If the team owns a PL club, returns the PL short
 * code (e.g. "LIV"); otherwise falls back to the first three characters of the team name in caps.
 * Used in dense surfaces where space is tight (nomination chips, compact tables).
 */
export function getTeamDisplayShort(
  team: TeamLike,
  ownership?: TeamClubOwnership | null,
  fallback: (team: TeamLike) => string = (t) => t.name.slice(0, 3).toUpperCase(),
): string {
  return ownership?.plTeamShort ?? fallback(team);
}

/** Tier display label for chips. */
export const TIER_LABEL: Record<ClubTier, string> = {
  top8: "Top 8",
  mid: "Mid",
  promoted: "Promoted",
};
