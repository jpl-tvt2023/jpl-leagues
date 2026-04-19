import { NextRequest, NextResponse } from "next/server";
import { db, teams, teamPenalties, auctionSessions, leagues } from "@/lib/db";
import { eq, and, isNull, asc, desc, or } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { calculatePurse } from "@/lib/formats/auction/economy";

// Pricing rules: £2.5M while still inside the cycle that issued the penalty;
// £5M once that cycle has ended (i.e. before/during a later mini-auction).
const SAME_CYCLE_COST = 2_500_000;
const LATER_CYCLE_COST = 5_000_000;

/**
 * Determine the "current" cycle number for pricing purposes:
 * - If there's an active/paused session, use its cycleNumber.
 * - Otherwise use the highest cycleNumber across all sessions in the league.
 */
async function getCurrentCycle(leagueId: string): Promise<number> {
  const live = await db
    .select({ cycleNumber: auctionSessions.cycleNumber })
    .from(auctionSessions)
    .where(
      and(
        eq(auctionSessions.leagueId, leagueId),
        or(eq(auctionSessions.status, "active"), eq(auctionSessions.status, "paused"))
      )
    )
    .limit(1);
  if (live.length > 0) return live[0].cycleNumber ?? 0;

  const latest = await db
    .select({ cycleNumber: auctionSessions.cycleNumber })
    .from(auctionSessions)
    .where(eq(auctionSessions.leagueId, leagueId))
    .orderBy(desc(auctionSessions.cycleNumber))
    .limit(1);
  return latest[0]?.cycleNumber ?? 0;
}

export function priceForPenalty(incurredCycle: number, currentCycle: number): number {
  return incurredCycle === currentCycle ? SAME_CYCLE_COST : LATER_CYCLE_COST;
}

/**
 * GET /api/auction/redeem-slot?teamId=xxx
 * Returns the team's outstanding penalty rows with their current redemption price,
 * so the UI can render a "Redeem Penalty Slot (£X.XM)" button per row.
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

  const teamRow = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (teamRow.length === 0) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  const leagueId = teamRow[0].leagueId;
  const currentCycle = await getCurrentCycle(leagueId);

  const rows = await db
    .select()
    .from(teamPenalties)
    .where(and(eq(teamPenalties.teamId, teamId), isNull(teamPenalties.redeemedAt)))
    .orderBy(asc(teamPenalties.createdAt));

  return NextResponse.json({
    currentCycle,
    penalties: rows.map((r) => ({
      id: r.id,
      incurredCycle: r.incurredCycle,
      sessionId: r.sessionId,
      cost: priceForPenalty(r.incurredCycle, currentCycle),
      createdAt: r.createdAt,
    })),
    // Legacy slots without ledger rows (pre-migration) — priced at LATER_CYCLE_COST
    legacyUnledgeredSlots: Math.max(0, (teamRow[0].penaltySlots ?? 0) - rows.length),
    legacyCost: LATER_CYCLE_COST,
  });
}

/**
 * POST /api/auction/redeem-slot
 * Redeem a single penalty slot. Picks the cheapest unredeemed penalty by default,
 * or a specific one if `penaltyId` is provided. Pays from purse, decrements
 * teams.penaltySlots, marks the row redeemed.
 *
 * Body: { teamId, penaltyId? }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session || session.type !== "team") {
    return NextResponse.json({ error: "Team authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { teamId, penaltyId } = body;

  if (!teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }

  if (session.id !== teamId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const teamRow = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (teamRow.length === 0) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }
  const team = teamRow[0];

  if ((team.penaltySlots ?? 0) <= 0) {
    return NextResponse.json({ error: "No penalty slots to redeem" }, { status: 400 });
  }

  const leagueId = team.leagueId;
  const currentCycle = await getCurrentCycle(leagueId);
  const leagueRow = await db
    .select({ initialBudget: leagues.initialBudget })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  // Pick the penalty row to redeem. If a specific id is passed, use it;
  // otherwise pick the cheapest (i.e. same-cycle first, falling back to oldest).
  let chosen:
    | { id: string; incurredCycle: number; cost: number }
    | null = null;

  const unredeemed = await db
    .select()
    .from(teamPenalties)
    .where(and(eq(teamPenalties.teamId, teamId), isNull(teamPenalties.redeemedAt)))
    .orderBy(asc(teamPenalties.createdAt));

  if (penaltyId) {
    const row = unredeemed.find((r) => r.id === penaltyId);
    if (!row) {
      return NextResponse.json({ error: "Penalty not found or already redeemed" }, { status: 404 });
    }
    chosen = { id: row.id, incurredCycle: row.incurredCycle, cost: priceForPenalty(row.incurredCycle, currentCycle) };
  } else if (unredeemed.length > 0) {
    const priced = unredeemed.map((r) => ({
      id: r.id,
      incurredCycle: r.incurredCycle,
      cost: priceForPenalty(r.incurredCycle, currentCycle),
    }));
    priced.sort((a, b) => a.cost - b.cost || a.incurredCycle - b.incurredCycle);
    chosen = priced[0];
  }

  // Legacy fallback: counter > 0 but no ledger row (pre-migration penalties).
  // Treat as later-cycle (£5M) — we have no record of when they were issued.
  const cost = chosen ? chosen.cost : LATER_CYCLE_COST;

  const availablePurse = calculatePurse(
    leagueRow[0]?.initialBudget ?? 0,
    team.totalIncome,
    team.totalSpent,
    team.totalRefunds
  );
  if (availablePurse < cost) {
    return NextResponse.json(
      { error: `Insufficient purse. Redemption costs £${(cost / 1_000_000).toFixed(2)}M` },
      { status: 400 }
    );
  }

  // Apply redemption atomically
  await db.transaction(async (tx) => {
    if (chosen) {
      await tx
        .update(teamPenalties)
        .set({ redeemedAt: new Date(), redemptionPrice: cost })
        .where(eq(teamPenalties.id, chosen.id));
    }
    await tx
      .update(teams)
      .set({
        penaltySlots: (team.penaltySlots ?? 0) - 1,
        totalSpent: (team.totalSpent ?? 0) + cost,
      })
      .where(eq(teams.id, teamId));
  });

  return NextResponse.json({
    success: true,
    cost,
    incurredCycle: chosen?.incurredCycle ?? null,
    currentCycle,
    remainingPenaltySlots: (team.penaltySlots ?? 0) - 1,
  });
}
