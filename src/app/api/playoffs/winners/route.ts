import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues, playoffTies, teams, players } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

interface Winner {
  position: number;
  label: string;
  category: "championship" | "challenger";
  teamId: string;
  teamName: string;
  teamAbbr: string;
  players: { name: string; fplId: string }[];
}

interface WinnersResponse {
  concluded: boolean;
  winners: Winner[];
}

export async function GET(req: NextRequest): Promise<NextResponse<WinnersResponse>> {
  try {
    const leagueSlug = req.nextUrl.searchParams.get("leagueSlug");

    if (!leagueSlug) {
      return NextResponse.json(
        { concluded: false, winners: [] },
        { status: 400 }
      );
    }

    // Resolve league
    const league = await db.query.leagues.findFirst({
      where: eq(leagues.slug, leagueSlug),
    });

    if (!league) {
      return NextResponse.json(
        { concluded: false, winners: [] },
        { status: 404 }
      );
    }

    const leagueId = league.id;
    const teamSize = league.teamSize ?? 8;

    // Determine final tie ID by format
    let finalTieId: string;
    if (teamSize === 8) {
      finalTieId = "8T-FINAL";
    } else if (teamSize === 16) {
      finalTieId = "16T-FINAL";
    } else {
      finalTieId = "Final";
    }

    // Query final tie
    const finalTie = await db.query.playoffTies.findFirst({
      where: and(eq(playoffTies.tieId, finalTieId), eq(playoffTies.leagueId, leagueId)),
    });

    // If not concluded, return early
    if (!finalTie || finalTie.status !== "complete") {
      return NextResponse.json({ concluded: false, winners: [] });
    }

    // Build winners array based on format
    let winnersData: Winner[] = [];

    if (teamSize === 8) {
      winnersData = await build8TeamWinners(leagueId);
    } else if (teamSize === 16) {
      winnersData = await build16TeamWinners(leagueId);
    } else {
      winnersData = await build32TeamWinners(leagueId);
    }

    return NextResponse.json({ concluded: true, winners: winnersData });
  } catch (error) {
    console.error("Winners API error:", error);
    return NextResponse.json(
      { concluded: false, winners: [] },
      { status: 500 }
    );
  }
}

async function build8TeamWinners(leagueId: string): Promise<Winner[]> {
  const winners: Winner[] = [];

  // Position 1: Final winner
  const finalTie = await db.query.playoffTies.findFirst({
    where: and(eq(playoffTies.tieId, "8T-FINAL"), eq(playoffTies.leagueId, leagueId)),
  });

  if (finalTie?.winnerId) {
    const teamData = await getTeamData(finalTie.winnerId);
    if (teamData) {
      winners.push({
        position: 1,
        label: "Champion",
        category: "championship",
        ...teamData,
      });
    }
  }

  // Position 2: Final loser
  if (finalTie?.loserId) {
    const teamData = await getTeamData(finalTie.loserId);
    if (teamData) {
      winners.push({
        position: 2,
        label: "Runner-Up",
        category: "championship",
        ...teamData,
      });
    }
  }

  // Position 3: 3rd Place winner
  const thirdPlaceTie = await db.query.playoffTies.findFirst({
    where: and(eq(playoffTies.tieId, "8T-3RD"), eq(playoffTies.leagueId, leagueId)),
  });

  if (thirdPlaceTie?.winnerId) {
    const teamData = await getTeamData(thirdPlaceTie.winnerId);
    if (teamData) {
      winners.push({
        position: 3,
        label: "3rd Place",
        category: "championship",
        ...teamData,
      });
    }
  }

  return winners;
}

async function build16TeamWinners(leagueId: string): Promise<Winner[]> {
  const winners: Winner[] = [];

  const tieIds = [
    { id: "16T-FINAL", pos: 1, label: "Champion", category: "championship" as const, winnerPos: true },
    { id: "16T-FINAL", pos: 2, label: "Runner-Up", category: "championship" as const, winnerPos: false },
    { id: "16T-CFINAL", pos: 3, label: "Challenger Champion", category: "challenger" as const, winnerPos: true },
    { id: "16T-CFINAL", pos: 4, label: "Challenger Runner-Up", category: "challenger" as const, winnerPos: false },
    { id: "16T-C3RD", pos: 5, label: "Challenger 3rd Place", category: "challenger" as const, winnerPos: true },
    { id: "16T-C3RD", pos: 6, label: "Challenger 4th Place", category: "challenger" as const, winnerPos: false },
  ];

  for (const tieInfo of tieIds) {
    const tie = await db.query.playoffTies.findFirst({
      where: and(eq(playoffTies.tieId, tieInfo.id), eq(playoffTies.leagueId, leagueId)),
    });

    if (tie) {
      const teamId = tieInfo.winnerPos ? tie.winnerId : tie.loserId;
      if (teamId) {
        const teamData = await getTeamData(teamId);
        if (teamData) {
          winners.push({
            position: tieInfo.pos,
            label: tieInfo.label,
            category: tieInfo.category,
            ...teamData,
          });
        }
      }
    }
  }

  return winners;
}

async function build32TeamWinners(leagueId: string): Promise<Winner[]> {
  const winners: Winner[] = [];

  const tieIds = [
    { id: "Final", pos: 1, label: "TVT Champion", category: "championship" as const, winnerPos: true },
    { id: "Final", pos: 2, label: "TVT Runner-Up", category: "championship" as const, winnerPos: false },
    { id: "C-38-A", pos: 3, label: "Challenger Champion", category: "challenger" as const, winnerPos: true },
    { id: "C-38-A", pos: 4, label: "Challenger Runner-Up", category: "challenger" as const, winnerPos: false },
    { id: "C-37-A", pos: 5, label: "Challenger SF (A)", category: "challenger" as const, winnerPos: false },
    { id: "C-37-B", pos: 6, label: "Challenger SF (B)", category: "challenger" as const, winnerPos: false },
    { id: "C-36-A", pos: 7, label: "Challenger QF (A)", category: "challenger" as const, winnerPos: false },
    { id: "C-36-B", pos: 8, label: "Challenger QF (B)", category: "challenger" as const, winnerPos: false },
    { id: "C-35-A", pos: 9, label: "Challenger R16 (A)", category: "challenger" as const, winnerPos: false },
    { id: "C-35-B", pos: 10, label: "Challenger R16 (B)", category: "challenger" as const, winnerPos: false },
    { id: "C-35-C", pos: 11, label: "Challenger R16 (C)", category: "challenger" as const, winnerPos: false },
    { id: "C-35-D", pos: 12, label: "Challenger R16 (D)", category: "challenger" as const, winnerPos: false },
  ];

  for (const tieInfo of tieIds) {
    const tie = await db.query.playoffTies.findFirst({
      where: and(eq(playoffTies.tieId, tieInfo.id), eq(playoffTies.leagueId, leagueId)),
    });

    if (tie) {
      const teamId = tieInfo.winnerPos ? tie.winnerId : tie.loserId;
      if (teamId) {
        const teamData = await getTeamData(teamId);
        if (teamData) {
          winners.push({
            position: tieInfo.pos,
            label: tieInfo.label,
            category: tieInfo.category,
            ...teamData,
          });
        }
      }
    }
  }

  return winners;
}

async function getTeamData(teamId: string): Promise<Omit<Winner, "position" | "label" | "category"> | null> {
  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
  });

  if (!team) return null;

  const teamPlayers = await db.query.players.findMany({
    where: eq(players.teamId, teamId),
  });

  return {
    teamId: team.id,
    teamName: team.name,
    teamAbbr: team.abbreviation,
    players: teamPlayers.map((p) => ({
      name: p.name,
      fplId: p.fplId,
    })),
  };
}
