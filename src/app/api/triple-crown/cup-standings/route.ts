/**
 * GET /api/triple-crown/cup-standings?leagueId=...
 * Fetch cup group standings for Triple Crown format
 *
 * Returns standings for each cup group (A/B/C/D):
 * - W/D/L records
 * - Goals for/against
 * - Cup group points
 * - Excludes Ghost teams from display (but counts them for score calculations)
 */

import { NextRequest, NextResponse } from "next/server";
import { db, teams, fixtures, groups, results, gameweeks } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { computeCupGroupStandings } from "@/lib/formats/triple-crown/standings";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const leagueId = searchParams.get("leagueId");

    if (!leagueId) {
      return NextResponse.json(
        { error: "leagueId query parameter required" },
        { status: 400 }
      );
    }

    // Fetch all cup groups for this league
    const cupGroups = await db.select().from(groups).where(
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "cup"))
    ).orderBy(groups.name);

    if (cupGroups.length === 0) {
      return NextResponse.json(
        { error: "No cup groups found. Run 'Seed Cup Groups' first." },
        { status: 404 }
      );
    }

    // Compute standings for each cup group
    const allStandings: Record<string, any> = {};

    for (const cupGroup of cupGroups) {
      // Get all teams in this cup group (including Ghost)
      const groupTeams = await db.select().from(teams).where(
        eq(teams.groupId, cupGroup.id)
      );

      if (groupTeams.length === 0) continue;

      // Get all cup group fixtures and results
      const cupFixtures = await db.query.fixtures.findMany({
        where: and(
          eq(fixtures.groupId, cupGroup.id),
          eq(fixtures.competitionType, "cup-group")
        ),
        with: { result: true },
      });

      // Collect results
      const fixtureResults = cupFixtures
        .filter(f => f.result)
        .map(f => ({
          fixtureId: f.id,
          homeTeamId: f.homeTeamId,
          awayTeamId: f.awayTeamId,
          homeScore: f.result!.homeScore,
          awayScore: f.result!.awayScore,
          homeMatchPoints: f.result!.homeMatchPoints,
          awayMatchPoints: f.result!.awayMatchPoints,
        }));

      // Compute standings using Triple Crown logic
      const standings = computeCupGroupStandings(
        groupTeams.map(t => ({
          id: t.id,
          name: t.name,
          abbreviation: t.abbreviation,
          isGhost: t.isGhost,
        })),
        fixtureResults
      );

      // Filter out Ghost team from display
      const humanStandings = standings.filter(s => !s.isGhost);

      allStandings[cupGroup.name] = {
        groupName: cupGroup.name,
        standings: humanStandings.map(s => ({
          rank: humanStandings.indexOf(s) + 1,
          teamId: s.teamId,
          teamName: s.name,
          teamAbbr: s.abbreviation,
          wins: s.wins,
          draws: s.draws,
          losses: s.losses,
          goalFor: s.goalFor,
          goalAgainst: s.goalAgainst,
          goalDifference: s.goalFor - s.goalAgainst,
          cupGroupPoints: s.cupGroupPoints,
        })),
        processedFixtures: fixtureResults.length,
      };
    }

    return NextResponse.json({
      success: true,
      leagueId,
      cupGroupStandings: allStandings,
    });
  } catch (error) {
    console.error("Error fetching cup standings:", error);
    return NextResponse.json(
      { error: "Failed to fetch cup standings" },
      { status: 500 }
    );
  }
}
