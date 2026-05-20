import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionOwnership, auctionScores, auctionClubOwnership, auctionSessions, teamPenalties } from "@/lib/db";
import { eq, and, isNull, desc, or } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { calculateFMV, calculatePurse } from "@/lib/formats/auction/economy";
import { fetchElementInfo, fetchBootstrapData } from "@/lib/fpl";
import type { ClubTier } from "@/lib/db/schema";
import {
  MAX_SQUAD_SIZE,
  MAX_BONUS_SLOTS,
  effectiveMaxSquadSize,
  nextBonusSlotCost,
} from "@/lib/formats/auction/squad-rules";
import { getPlTeamFullName } from "@/lib/data/pl-team-full-names";

// Mirrors the constants in redeem-slot/route.ts. Surfaces the cheapest redeem cost so the slot-
// status UI can render the inline Redeem button without a second API call.
const REDEEM_SAME_CYCLE_COST = 2_500_000;
const REDEEM_LATER_CYCLE_COST = 5_000_000;

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
        // Normalise legacy rows to the full PL name; new writes are already full names.
        plTeamName: getPlTeamFullName(clubRow[0].plTeamId, clubRow[0].plTeamName),
        plTeamShort: clubRow[0].plTeamShort,
        tier: clubRow[0].tier as ClubTier,
      }
    : null;
  const displayName = ownedClub?.plTeamName ?? teamRow[0].name;

  // ── Slot status — consolidates open / penalty / locked into one block for <SlotStatus>. ──
  const activeCount = squad.filter((p) => p.status === "active").length;
  const penaltySlots = teamRow[0].penaltySlots ?? 0;
  const bonusSlots = teamRow[0].bonusSlots ?? 0;
  const effectiveMax = effectiveMaxSquadSize(penaltySlots, bonusSlots);
  const open = Math.max(0, effectiveMax - activeCount);
  const lockedCount = MAX_BONUS_SLOTS - bonusSlots;
  const nextUnlockCost = nextBonusSlotCost(bonusSlots);

  // Is the initial auction complete? Required gate for unlock.
  const initialSession = await db
    .select({ status: auctionSessions.status })
    .from(auctionSessions)
    .where(and(eq(auctionSessions.leagueId, leagueRow[0].id), eq(auctionSessions.type, "initial")))
    .limit(1);
  const initialAuctionCompleted = initialSession[0]?.status === "completed";

  const availablePurse = calculatePurse(
    leagueRow[0].initialBudget,
    teamRow[0].totalIncome,
    teamRow[0].totalSpent,
    teamRow[0].totalRefunds,
  );
  const canUnlock =
    nextUnlockCost != null && initialAuctionCompleted && availablePurse >= nextUnlockCost;
  const unlockBlockedReason = nextUnlockCost == null
    ? "all bonus slots already unlocked"
    : !initialAuctionCompleted
      ? "initial auction in progress"
      : availablePurse < nextUnlockCost
        ? "insufficient purse"
        : null;

  // Cheapest unredeemed penalty cost — null when no penalty rows exist. Mirrors the pricing in the
  // redeem-slot route: same-cycle = £2.5M, later cycle = £5M.
  let redeemableCost: number | null = null;
  let canRedeem = false;
  if (penaltySlots > 0) {
    const liveSess = await db
      .select({ cycleNumber: auctionSessions.cycleNumber })
      .from(auctionSessions)
      .where(and(
        eq(auctionSessions.leagueId, leagueRow[0].id),
        or(eq(auctionSessions.status, "active"), eq(auctionSessions.status, "paused")),
      ))
      .limit(1);
    let currentCycle = liveSess[0]?.cycleNumber ?? 0;
    if (liveSess.length === 0) {
      const latest = await db
        .select({ cycleNumber: auctionSessions.cycleNumber })
        .from(auctionSessions)
        .where(eq(auctionSessions.leagueId, leagueRow[0].id))
        .orderBy(desc(auctionSessions.cycleNumber))
        .limit(1);
      currentCycle = latest[0]?.cycleNumber ?? 0;
    }
    const unredeemed = await db
      .select({ incurredCycle: teamPenalties.incurredCycle })
      .from(teamPenalties)
      .where(and(eq(teamPenalties.teamId, teamId), isNull(teamPenalties.redeemedAt)));
    const costs = unredeemed.map((r) =>
      r.incurredCycle === currentCycle ? REDEEM_SAME_CYCLE_COST : REDEEM_LATER_CYCLE_COST
    );
    // Legacy slots without ledger rows: priced at later-cycle cost.
    const legacyCount = Math.max(0, penaltySlots - unredeemed.length);
    for (let i = 0; i < legacyCount; i++) costs.push(REDEEM_LATER_CYCLE_COST);
    redeemableCost = costs.length > 0 ? Math.min(...costs) : null;
    canRedeem = redeemableCost != null && availablePurse >= redeemableCost;
  }

  return NextResponse.json({
    teamId,
    teamName: displayName,
    leagueId: leagueRow[0].id,
    squad,
    activeCount,
    deadwoodCount: squad.filter((p) => p.status === "deadwood").length,
    ownedClub,
    slotStatus: {
      active: activeCount,
      effectiveMax,
      baseCap: MAX_SQUAD_SIZE,
      bonusSlots,
      penaltySlots,
      open,
      lockedCount,
      nextUnlockCost,
      canUnlock,
      unlockBlockedReason,
      redeemableCost,
      canRedeem,
      initialAuctionCompleted,
    },
  });
}
