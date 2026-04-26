import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionOwnership, auctionScores, gameweeks } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { calculateFMV } from "@/lib/formats/auction/economy";
import { computeAuctionStandings } from "@/lib/formats/auction/standings";
import { fetchElementInfo } from "@/lib/fpl";

/**
 * GET /api/auction/teams?leagueId=xxx
 * Returns all teams in the auction league with aggregates:
 * rank, total points, purse, squad value (FMV), squad size, top performer.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  const leagueId = request.nextUrl.searchParams.get("leagueId");
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  const myTeamId = session?.type === "team" ? session.id : null;

  const leagueTeams = await db
    .select({
      id: teams.id,
      name: teams.name,
      purse: teams.purse,
    })
    .from(teams)
    .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false)));

  const scores = await db
    .select()
    .from(auctionScores)
    .where(eq(auctionScores.leagueId, leagueId));

  const gwRows = await db
    .select({ id: gameweeks.id, number: gameweeks.number })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId));
  const gwNumbers = new Map(gwRows.map((g) => [g.id, g.number]));

  const allOwnership = await db
    .select()
    .from(auctionOwnership)
    .where(and(eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.status, "active")));

  // Per-player accumulated points per team (for FMV + top performer)
  // key: `${teamId}:${elementId}` -> points
  const playerPointsByTeam = new Map<string, number>();
  for (const s of scores) {
    const breakdown = JSON.parse(s.playerBreakdown || "[]") as { elementId: number; points: number }[];
    for (const p of breakdown) {
      const key = `${s.teamId}:${p.elementId}`;
      playerPointsByTeam.set(key, (playerPointsByTeam.get(key) ?? 0) + p.points);
    }
  }

  const squadValues = new Map<string, number>();
  const squadSize = new Map<string, number>();
  const topPerformerByTeam = new Map<string, { elementId: number; points: number }>();

  for (const owned of allOwnership) {
    const pts = playerPointsByTeam.get(`${owned.teamId}:${owned.fplElementId}`) ?? 0;
    const fmv = calculateFMV(owned.purchasePrice, pts);
    squadValues.set(owned.teamId, (squadValues.get(owned.teamId) ?? 0) + fmv);
    squadSize.set(owned.teamId, (squadSize.get(owned.teamId) ?? 0) + 1);

    const cur = topPerformerByTeam.get(owned.teamId);
    if (!cur || pts > cur.points) {
      topPerformerByTeam.set(owned.teamId, { elementId: owned.fplElementId, points: pts });
    }
  }

  const standings = computeAuctionStandings(leagueTeams, scores, gwNumbers, squadValues);

  // Resolve top performer names from FPL bootstrap
  const elements = await fetchElementInfo();
  const elementName = new Map<number, string>();
  for (const e of elements) elementName.set(e.id, e.web_name);

  const teamList = standings.map((s) => {
    const tp = topPerformerByTeam.get(s.teamId);
    return {
      teamId: s.teamId,
      name: s.teamName,
      rank: s.rank,
      totalPoints: s.totalPoints,
      purse: s.purse,
      squadValue: s.squadValue,
      squadSize: squadSize.get(s.teamId) ?? 0,
      topPerformer: tp
        ? { name: elementName.get(tp.elementId) ?? `#${tp.elementId}`, points: tp.points }
        : null,
      isMine: s.teamId === myTeamId,
    };
  });

  return NextResponse.json({ teams: teamList, totalTeams: teamList.length });
}
