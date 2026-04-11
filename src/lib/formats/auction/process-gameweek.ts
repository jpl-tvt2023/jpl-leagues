// JPL Auction Gameweek Processor
// Scores all teams, ranks them, assigns payouts, updates purses

import { db, teams, auctionScores } from "../../db";
import { eq, and } from "drizzle-orm";
import { calculateAuctionTeamScore } from "./scoring";
import { getPayoutForRank } from "./economy";
import { randomUUID } from "crypto";

export interface AuctionProcessResult {
  success: boolean;
  teamsProcessed: number;
  scores: { teamId: string; teamName: string; totalPoints: number; rank: number; payout: number }[];
  error?: string;
}

/**
 * Process a gameweek for an auction league:
 * 1. Calculate each team's squad score (sum of 14 owned elements' GW points)
 * 2. Rank teams by GW score
 * 3. Assign income payouts based on rank
 * 4. Update teams.purse and teams.totalIncome
 * 5. Store results in auctionScores table
 */
export async function processAuctionGameweek(
  gameweekId: string,
  gameweekNumber: number,
  leagueId: string,
  forceReprocess: boolean
): Promise<AuctionProcessResult> {
  // Check if already processed
  if (!forceReprocess) {
    const existing = await db
      .select()
      .from(auctionScores)
      .where(
        and(
          eq(auctionScores.leagueId, leagueId),
          eq(auctionScores.gameweekId, gameweekId)
        )
      );
    if (existing.length > 0) {
      return {
        success: true,
        teamsProcessed: existing.length,
        scores: existing.map((s) => ({
          teamId: s.teamId,
          teamName: "",
          totalPoints: s.totalPoints,
          rank: s.rank ?? 0,
          payout: s.payout,
        })),
      };
    }
  }

  // Get all non-ghost teams in this league
  const leagueTeams = await db
    .select()
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)));

  if (leagueTeams.length === 0) {
    return { success: false, teamsProcessed: 0, scores: [], error: "No teams found" };
  }

  // Calculate scores for all teams
  const teamScores = await Promise.all(
    leagueTeams.map(async (team) => {
      const score = await calculateAuctionTeamScore(leagueId, team.id, gameweekNumber);
      return { ...score, teamName: team.name };
    })
  );

  // Rank by GW score (descending)
  teamScores.sort((a, b) => b.totalPoints - a.totalPoints);

  // Assign ranks and payouts
  const rankedScores = teamScores.map((score, index) => {
    const rank = index + 1;
    const payout = getPayoutForRank(rank);
    return { ...score, rank, payout };
  });

  // Atomically write scores and update purses
  await db.transaction(async (tx) => {
    // Delete existing scores for this GW if reprocessing
    if (forceReprocess) {
      // Delete one by one since Drizzle SQLite doesn't support compound where on delete easily
      const existingScores = await tx
        .select({ id: auctionScores.id })
        .from(auctionScores)
        .where(
          and(
            eq(auctionScores.leagueId, leagueId),
            eq(auctionScores.gameweekId, gameweekId)
          )
        );
      for (const existing of existingScores) {
        await tx.delete(auctionScores).where(eq(auctionScores.id, existing.id));
      }
    }

    for (const score of rankedScores) {
      // Insert auction score
      await tx.insert(auctionScores).values({
        id: randomUUID(),
        leagueId,
        teamId: score.teamId,
        gameweekId,
        totalPoints: score.totalPoints,
        playerBreakdown: JSON.stringify(score.playerBreakdown),
        rank: score.rank,
        payout: score.payout,
      });

      // Update team purse and income
      const team = leagueTeams.find((t) => t.id === score.teamId);
      if (team) {
        await tx
          .update(teams)
          .set({
            purse: team.purse + score.payout,
            totalIncome: team.totalIncome + score.payout,
            updatedAt: new Date(),
          })
          .where(eq(teams.id, score.teamId));
      }
    }
  });

  return {
    success: true,
    teamsProcessed: rankedScores.length,
    scores: rankedScores.map((s) => ({
      teamId: s.teamId,
      teamName: s.teamName,
      totalPoints: s.totalPoints,
      rank: s.rank,
      payout: s.payout,
    })),
  };
}
