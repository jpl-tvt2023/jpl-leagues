import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionOwnership, auctionScores, auctionClubOwnership } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { calculateFMV } from "@/lib/formats/auction/economy";
import { fetchElementInfo, fetchBootstrapData } from "@/lib/fpl";
import type { ClubTier } from "@/lib/db/schema";

/**
 * GET /api/auction/squad?teamId=xxx
 * Returns a team's 14-player auction squad with stats and FMV.
 * Accessible by any authenticated team in the same league, or admin.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teamId = request.nextUrl.searchParams.get("teamId");
  if (!teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }

  // Get the team and verify it belongs to an auction league
  const teamRow = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (teamRow.length === 0) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, teamRow[0].leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  // Get all owned players (active + deadwood)
  const ownedPlayers = await db
    .select()
    .from(auctionOwnership)
    .where(
      and(
        eq(auctionOwnership.leagueId, leagueRow[0].id),
        eq(auctionOwnership.teamId, teamId)
      )
    );

  // Get all auction scores for this team to compute cumulative points per player
  const scores = await db
    .select()
    .from(auctionScores)
    .where(
      and(
        eq(auctionScores.leagueId, leagueRow[0].id),
        eq(auctionScores.teamId, teamId)
      )
    );

  // Accumulate total points per element across all GWs.
  // FMV uses RAW points only (synergy never compounds into FMV / squad value / trades).
  // Post-club-auction breakdown shape: {elementId, rawPoints, synergyBonus, plTeamId}.
  // Legacy pre-club-auction shape: {elementId, points}. Tolerate both at read time.
  const elementTotalPoints = new Map<number, number>();
  for (const score of scores) {
    const breakdown: Array<{ elementId: number; points?: number; rawPoints?: number }> = JSON.parse(score.playerBreakdown);
    for (const p of breakdown) {
      const pts = p.rawPoints ?? p.points ?? 0;
      elementTotalPoints.set(p.elementId, (elementTotalPoints.get(p.elementId) ?? 0) + pts);
    }
  }

  // Build elementId → PL team (id + short_name) lookups from FPL caches.
  // Best-effort: if FPL is unavailable, players just render without the
  // club suffix — UI degrades gracefully.
  const plTeamByElement = new Map<number, { id: number; short: string }>();
  try {
    const [elements, bootstrap] = await Promise.all([fetchElementInfo(), fetchBootstrapData()]);
    const plTeamShortById = new Map<number, string>();
    for (const t of (bootstrap.teams ?? []) as { id: number; short_name: string }[]) {
      plTeamShortById.set(t.id, t.short_name);
    }
    for (const el of elements) {
      const short = plTeamShortById.get(el.team);
      if (short) plTeamByElement.set(el.id, { id: el.team, short });
    }
  } catch {
    // ignore — leave plTeamByElement empty
  }

  const squad = ownedPlayers
    .filter((p) => p.status !== "released")
    .map((p) => {
      const totalPoints = elementTotalPoints.get(p.fplElementId) ?? 0;
      const fmv = calculateFMV(p.purchasePrice, totalPoints);
      const plTeam = plTeamByElement.get(p.fplElementId);
      return {
        ownershipId: p.id,
        fplElementId: p.fplElementId,
        playerName: p.playerName,
        elementType: p.elementType,
        purchasePrice: p.purchasePrice,
        acquiredGw: p.acquiredGw,
        status: p.status,
        totalPoints,
        fmv,
        plTeamId: plTeam?.id ?? null,
        plTeamShort: plTeam?.short ?? null,
      };
    });

  // PL Club Auction: if this team owns a PL club, render the team as the club's name everywhere
  // and surface the club info for the Squad Overview tier chip.
  const clubRow = await db
    .select()
    .from(auctionClubOwnership)
    .where(and(
      eq(auctionClubOwnership.leagueId, leagueRow[0].id),
      eq(auctionClubOwnership.teamId, teamId),
    ))
    .limit(1);
  const ownedClub = clubRow[0]
    ? {
        plTeamId: clubRow[0].plTeamId,
        plTeamName: clubRow[0].plTeamName,
        plTeamShort: clubRow[0].plTeamShort,
        tier: clubRow[0].tier as ClubTier,
      }
    : null;
  const displayName = ownedClub?.plTeamName ?? teamRow[0].name;

  return NextResponse.json({
    teamId,
    teamName: displayName,
    leagueId: leagueRow[0].id,
    squad,
    activeCount: squad.filter((p) => p.status === "active").length,
    deadwoodCount: squad.filter((p) => p.status === "deadwood").length,
    ownedClub,
  });
}
