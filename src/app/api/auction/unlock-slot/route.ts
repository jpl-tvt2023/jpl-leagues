import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionSessions, teamSlotUnlocks } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { calculatePurse } from "@/lib/formats/auction/economy";
import {
  MAX_SQUAD_SIZE,
  MAX_BONUS_SLOTS,
  nextBonusSlotCost,
} from "@/lib/formats/auction/squad-rules";
import { createNotification } from "@/lib/notifications";
import { generateId } from "@/lib/id";

/**
 * POST /api/auction/unlock-slot
 * Body: { teamId }
 *
 * Unlocks the next bonus squad slot (15, then 16) for a team. Cost is deducted from purse and
 * `teams.bonusSlots` increments by 1. Gated on the initial auction having completed for the league
 * — locked slots are not available during the initial auction.
 *
 * Pricing comes from `BONUS_SLOT_PRICES` in squad-rules.ts (£10M for slot 15, £25M for slot 16).
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const admin = isSuperAdmin(request);

  if (!session && !admin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const teamId = typeof body?.teamId === "string" ? body.teamId : null;
  if (!teamId) {
    return NextResponse.json({ error: "teamId is required" }, { status: 400 });
  }

  // Caller must be the team owner (or admin)
  if (!admin && session?.type === "team" && session.id !== teamId) {
    return NextResponse.json({ error: "Can only unlock slots for your own team" }, { status: 403 });
  }

  const teamRow = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (teamRow.length === 0) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }
  const team = teamRow[0];

  const leagueRow = await db
    .select({ id: leagues.id, format: leagues.format, initialBudget: leagues.initialBudget })
    .from(leagues)
    .where(eq(leagues.id, team.leagueId))
    .limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }
  const league = leagueRow[0];

  // Already at the cap?
  const currentBonusSlots = team.bonusSlots ?? 0;
  if (currentBonusSlots >= MAX_BONUS_SLOTS) {
    return NextResponse.json(
      { error: `All bonus slots already unlocked (squad cap ${MAX_SQUAD_SIZE + MAX_BONUS_SLOTS})` },
      { status: 400 }
    );
  }

  // Gate: initial auction must be completed. Locked slots cannot be filled (or unlocked)
  // during the initial auction — per spec, the initial auction fills only 14 slots.
  const initialSession = await db
    .select({ status: auctionSessions.status })
    .from(auctionSessions)
    .where(and(eq(auctionSessions.leagueId, league.id), eq(auctionSessions.type, "initial")))
    .limit(1);
  if (initialSession.length === 0) {
    return NextResponse.json(
      { error: "Cannot unlock bonus slots before the initial auction has been created" },
      { status: 409 }
    );
  }
  if (initialSession[0].status !== "completed") {
    return NextResponse.json(
      { error: "Cannot unlock bonus slots while the initial auction is in progress — must wait until it completes" },
      { status: 409 }
    );
  }

  const cost = nextBonusSlotCost(currentBonusSlots);
  if (cost == null) {
    return NextResponse.json({ error: "All bonus slots already unlocked" }, { status: 400 });
  }

  // Purse check — available purse = initialBudget + totalIncome + totalRefunds − totalSpent.
  const availablePurse = calculatePurse(
    league.initialBudget,
    team.totalIncome,
    team.totalSpent,
    team.totalRefunds,
  );
  if (availablePurse < cost) {
    return NextResponse.json(
      { error: `Insufficient purse: need £${(cost / 1_000_000).toFixed(1)}M, have £${(availablePurse / 1_000_000).toFixed(2)}M` },
      { status: 400 }
    );
  }

  const slotNumber = MAX_SQUAD_SIZE + currentBonusSlots + 1; // The slot being unlocked (15 or 16).
  const unlockedAt = new Date();

  // Apply the unlock atomically — column updates + audit row in one transaction.
  await db.transaction(async (tx) => {
    await tx
      .update(teams)
      .set({
        purse: sql`${teams.purse} - ${cost}`,
        totalSpent: sql`${teams.totalSpent} + ${cost}`,
        bonusSlots: currentBonusSlots + 1,
        updatedAt: unlockedAt,
      })
      .where(eq(teams.id, teamId));

    // Audit row feeds the Finance ledger so the unlock appears as a "Slot Unlock" outflow rather
    // than getting buried in the aggregate teams.totalSpent counter.
    await tx.insert(teamSlotUnlocks).values({
      id: generateId(),
      leagueId: league.id,
      teamId,
      slotNumber,
      cost,
      unlockedAt,
    });
  });

  const newBonusSlots = currentBonusSlots + 1;
  const newCap = MAX_SQUAD_SIZE + newBonusSlots;
  const nextCost = nextBonusSlotCost(newBonusSlots);
  const slotIndex = MAX_SQUAD_SIZE + newBonusSlots; // The slot that was just unlocked (15 or 16).

  // Best-effort notification — never fail the unlock response.
  try {
    await createNotification({
      teamId,
      leagueId: league.id,
      type: "slot_unlocked",
      title: `Unlocked slot ${slotIndex}`,
      body: `£${(cost / 1_000_000).toFixed(1)}M deducted. Squad cap is now ${newCap}.`,
    });
  } catch (e) {
    console.warn("[unlock-slot] notify slot_unlocked failed", { teamId, error: e });
  }

  return NextResponse.json({
    success: true,
    bonusSlots: newBonusSlots,
    newCap,
    spent: cost,
    nextUnlockCost: nextCost,
  });
}
