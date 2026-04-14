// JPL Auction Scoring Engine
// Team score = sum of all owned players' individual GW FPL points
// No captain multiplier, no chips, no H2H

import { fetchElementGameweekPoints } from "../../fpl";
import { db, auctionOwnership } from "../../db";
import { eq, and, lt, gte, or, isNull } from "drizzle-orm";

export interface AuctionPlayerBreakdown {
  elementId: number;
  name: string;
  points: number;
}

export interface AuctionTeamGwScore {
  teamId: string;
  totalPoints: number;
  playerBreakdown: AuctionPlayerBreakdown[];
}

/**
 * Calculate an auction team's GW score by summing all owned players' element points.
 * Fetches the element points map (cached) and looks up ownership from DB.
 */
export async function calculateAuctionTeamScore(
  leagueId: string,
  teamId: string,
  gameweek: number
): Promise<AuctionTeamGwScore> {
  // Get players owned by this team during the target GW.
  // acquiredGw < gameweek: player was acquired before this GW (acquiredGw=0 earns from GW1)
  // releasedGw IS NULL OR releasedGw >= gameweek: player hadn't been released yet
  const ownedPlayers = await db
    .select()
    .from(auctionOwnership)
    .where(
      and(
        eq(auctionOwnership.leagueId, leagueId),
        eq(auctionOwnership.teamId, teamId),
        lt(auctionOwnership.acquiredGw, gameweek),
        or(
          isNull(auctionOwnership.releasedGw),
          gte(auctionOwnership.releasedGw, gameweek),
        ),
      )
    );

  // Fetch all element GW points (single API call, cached)
  const elementPoints = await fetchElementGameweekPoints(gameweek);

  // Sum up owned players' points
  const playerBreakdown: AuctionPlayerBreakdown[] = ownedPlayers.map((p) => ({
    elementId: p.fplElementId,
    name: p.playerName,
    points: elementPoints[p.fplElementId] ?? 0,
  }));

  const totalPoints = playerBreakdown.reduce((sum, p) => sum + p.points, 0);

  return {
    teamId,
    totalPoints,
    playerBreakdown,
  };
}
