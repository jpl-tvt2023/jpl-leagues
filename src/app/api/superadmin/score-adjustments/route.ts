import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auctionScores, gameweeks, leagues, teams, auditLogs } from "@/lib/db/schema";
import { eq, and, desc, asc } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { getPayoutForRank } from "@/lib/formats/auction/economy";

/**
 * GET /api/superadmin/score-adjustments?leagueId=...&gameweek=...
 *
 * Returns the `auction_scores` rows for the given league + GW so the superadmin can edit the
 * PL Club Auction breakdown (synergyBonus, clubResultBonus). Without filters, returns the
 * list of auction leagues + the most-recent processed GW for each — used by the UI to seed
 * the filter dropdowns.
 */
export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const leagueId = searchParams.get("leagueId");
  const gwParam = searchParams.get("gameweek");

  if (!leagueId) {
    // Bootstrap data: list auction leagues with their available scored GWs.
    const auctionLeagues = await db
      .select({ id: leagues.id, slug: leagues.slug, name: leagues.name, season: leagues.season })
      .from(leagues)
      .where(eq(leagues.format, "auction"))
      .orderBy(desc(leagues.createdAt));

    const gwsByLeague: Record<string, number[]> = {};
    for (const l of auctionLeagues) {
      const rows = await db
        .selectDistinct({ number: gameweeks.number })
        .from(auctionScores)
        .innerJoin(gameweeks, eq(auctionScores.gameweekId, gameweeks.id))
        .where(eq(auctionScores.leagueId, l.id))
        .orderBy(asc(gameweeks.number));
      gwsByLeague[l.id] = rows.map((r) => r.number);
    }

    return NextResponse.json({ leagues: auctionLeagues, gwsByLeague });
  }

  const gwNumber = gwParam ? parseInt(gwParam, 10) : NaN;
  if (!Number.isFinite(gwNumber)) {
    return NextResponse.json({ error: "gameweek parameter required and must be an integer" }, { status: 400 });
  }

  // Resolve the gameweek id
  const gwRow = await db
    .select({ id: gameweeks.id, number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), eq(gameweeks.number, gwNumber)))
    .limit(1);
  if (gwRow.length === 0) {
    return NextResponse.json({ error: `GW${gwNumber} not found in this league` }, { status: 404 });
  }

  const scoreRows = await db
    .select({
      id: auctionScores.id,
      teamId: auctionScores.teamId,
      teamName: teams.name,
      totalPoints: auctionScores.totalPoints,
      rawPoints: auctionScores.rawPoints,
      synergyBonus: auctionScores.synergyBonus,
      clubResultBonus: auctionScores.clubResultBonus,
      rank: auctionScores.rank,
      payout: auctionScores.payout,
    })
    .from(auctionScores)
    .innerJoin(teams, eq(auctionScores.teamId, teams.id))
    .where(and(eq(auctionScores.leagueId, leagueId), eq(auctionScores.gameweekId, gwRow[0].id)))
    .orderBy(asc(auctionScores.rank));

  return NextResponse.json({
    leagueId,
    gameweekId: gwRow[0].id,
    gameweekNumber: gwRow[0].number,
    scores: scoreRows,
  });
}

/**
 * PATCH /api/superadmin/score-adjustments
 * Body: { id, synergyBonus?, clubResultBonus?, reason }
 *
 * Updates the editable PL Club Auction breakdown columns on an `auction_scores` row.
 * Recomputes `totalPoints` = rawPoints + synergyBonus + clubResultBonus.
 * Audit-logs the change with admin-supplied `reason`.
 */
export async function PATCH(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  let body: { id?: unknown; synergyBonus?: unknown; clubResultBonus?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (!reason) return NextResponse.json({ error: "reason is required (audit trail)" }, { status: 400 });

  // Bound the bonus values so a single typo can't wreck a GW total. The cap
  // is comfortably higher than any legitimate adjustment (a full GW's worth of
  // FPL points for one team is rarely above ~150) but still flags 1e9-style typos.
  const MAX_BONUS = 500;
  const MIN_BONUS = -500;
  const isValidBonus = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= MIN_BONUS && v <= MAX_BONUS;
  const synergyBonus: number | null = isValidBonus(body.synergyBonus) ? body.synergyBonus : null;
  const clubResultBonus: number | null = isValidBonus(body.clubResultBonus) ? body.clubResultBonus : null;
  if (synergyBonus === null && clubResultBonus === null) {
    if (
      (body.synergyBonus !== undefined && !isValidBonus(body.synergyBonus)) ||
      (body.clubResultBonus !== undefined && !isValidBonus(body.clubResultBonus))
    ) {
      return NextResponse.json(
        { error: `synergyBonus and clubResultBonus must be integers in [${MIN_BONUS}, ${MAX_BONUS}]` },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Provide at least one of synergyBonus or clubResultBonus" }, { status: 400 });
  }

  const existing = await db.select().from(auctionScores).where(eq(auctionScores.id, id)).limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Score row not found" }, { status: 404 });
  }
  const row = existing[0];

  const newSynergy = synergyBonus ?? row.synergyBonus;
  const newClubResult = clubResultBonus ?? row.clubResultBonus;
  const newTotal = row.rawPoints + newSynergy + newClubResult;
  const deltaTotal = newTotal - row.totalPoints;

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(auctionScores)
      .set({
        synergyBonus: newSynergy,
        clubResultBonus: newClubResult,
        totalPoints: newTotal,
      })
      .where(eq(auctionScores.id, id));

    // Re-rank + recompute payouts for the whole GW so leaderboard and finance ledger stay in sync.
    // A swap-changing adjustment (e.g. T2 overtakes T1) must move both rows' rank/payout columns,
    // not just the patched row's totalPoints. Tiebreak by teamId asc for determinism — the full
    // GW processor uses squad-value/purse tiebreakers which require FMV recompute (out of scope
    // for an inline PATCH and explicitly flagged on the defect as too heavy).
    const gwRows = await tx
      .select()
      .from(auctionScores)
      .where(and(eq(auctionScores.leagueId, row.leagueId), eq(auctionScores.gameweekId, row.gameweekId)));

    const ordered = [...gwRows].sort((a, b) => {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      return a.teamId.localeCompare(b.teamId);
    });

    for (let i = 0; i < ordered.length; i++) {
      const sr = ordered[i];
      const newRank = i + 1;
      const newPayout = getPayoutForRank(newRank);
      if (sr.rank === newRank && sr.payout === newPayout) continue;

      await tx
        .update(auctionScores)
        .set({ rank: newRank, payout: newPayout })
        .where(eq(auctionScores.id, sr.id));

      // Keep teams.purse and teams.totalIncome consistent with the new payout — buildAllTeamsSummary
      // reads teams.purse directly, so a stale value here desyncs the admin finance overview.
      const payoutDelta = newPayout - sr.payout;
      if (payoutDelta !== 0) {
        const teamRow = await tx.select().from(teams).where(eq(teams.id, sr.teamId)).limit(1);
        if (teamRow.length > 0) {
          await tx
            .update(teams)
            .set({
              purse: teamRow[0].purse + payoutDelta,
              totalIncome: teamRow[0].totalIncome + payoutDelta,
              updatedAt: now,
            })
            .where(eq(teams.id, sr.teamId));
        }
      }
    }

    const beforeAfter = [
      `synergy ${row.synergyBonus} → ${newSynergy}`,
      `clubResult ${row.clubResultBonus} → ${newClubResult}`,
      `total ${row.totalPoints} → ${newTotal}`,
    ].join("; ");

    await tx.insert(auditLogs).values({
      id: generateId(),
      type: "AUCTION_SCORE_ADJUSTMENT",
      description: `[Superadmin] ${beforeAfter} — Reason: ${reason}`,
      teamId: row.teamId,
      gameweekId: row.gameweekId,
      pointsAffected: deltaTotal,
    });
  });

  return NextResponse.json({
    success: true,
    id,
    rawPoints: row.rawPoints,
    synergyBonus: newSynergy,
    clubResultBonus: newClubResult,
    totalPoints: newTotal,
    deltaTotal,
  });
}
