import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionOwnership, tradeProposals, auctionScores } from "@/lib/db";
import { eq, and, or } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { validateTradeProposal, type TradePlayer } from "@/lib/formats/auction/marketplace";
import { calculateFMV } from "@/lib/formats/auction/economy";

/**
 * GET /api/auction/trade?leagueId=xxx&teamId=xxx
 * List trade proposals. If teamId provided, shows that team's proposals.
 * Otherwise shows all proposals for the league.
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const leagueId = request.nextUrl.searchParams.get("leagueId");
  const teamId = request.nextUrl.searchParams.get("teamId");

  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  let proposals;
  if (teamId) {
    proposals = await db
      .select()
      .from(tradeProposals)
      .where(
        and(
          eq(tradeProposals.leagueId, leagueId),
          or(
            eq(tradeProposals.proposerTeamId, teamId),
            eq(tradeProposals.targetTeamId, teamId)
          )
        )
      );
  } else {
    proposals = await db
      .select()
      .from(tradeProposals)
      .where(eq(tradeProposals.leagueId, leagueId));
  }

  return NextResponse.json({
    proposals: proposals.map((p) => ({
      id: p.id,
      proposerTeamId: p.proposerTeamId,
      targetTeamId: p.targetTeamId,
      offeredPlayerIds: JSON.parse(p.offeredPlayerIds),
      requestedPlayerIds: JSON.parse(p.requestedPlayerIds),
      cashOffered: p.cashOffered,
      status: p.status,
      vetoDeadline: p.vetoDeadline?.toISOString() ?? null,
      vetoVotes: JSON.parse(p.vetoVotes),
      createdAt: p.createdAt,
    })),
  });
}

/**
 * POST /api/auction/trade
 * Create a new trade proposal.
 *
 * Body: { leagueId, targetTeamId, offeredPlayerIds, requestedPlayerIds, cashOffered }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session || session.type !== "team") {
    return NextResponse.json({ error: "Team authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { leagueId, targetTeamId, offeredPlayerIds, requestedPlayerIds, cashOffered } = body;

  if (!leagueId || !targetTeamId) {
    return NextResponse.json({ error: "leagueId and targetTeamId are required" }, { status: 400 });
  }

  if (session.id === targetTeamId) {
    return NextResponse.json({ error: "Cannot trade with yourself" }, { status: 400 });
  }

  // Verify auction league
  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (leagueRow.length === 0 || leagueRow[0].format !== "auction") {
    return NextResponse.json({ error: "Not an auction league" }, { status: 400 });
  }

  // Build TradePlayer arrays with cumulative points for FMV
  const buildTradePlayers = async (ownershipIds: string[]): Promise<TradePlayer[]> => {
    const result: TradePlayer[] = [];
    for (const id of ownershipIds) {
      const row = await db.select().from(auctionOwnership).where(eq(auctionOwnership.id, id)).limit(1);
      if (row.length === 0 || row[0].status !== "active") continue;

      // Get cumulative points from auction scores
      const scores = await db
        .select()
        .from(auctionScores)
        .where(
          and(
            eq(auctionScores.leagueId, leagueId),
            eq(auctionScores.teamId, row[0].teamId)
          )
        );

      let totalPoints = 0;
      for (const score of scores) {
        const breakdown: { elementId: number; points: number }[] = JSON.parse(score.playerBreakdown);
        const playerEntry = breakdown.find((p) => p.elementId === row[0].fplElementId);
        if (playerEntry) totalPoints += playerEntry.points;
      }

      result.push({
        ownershipId: id,
        fplElementId: row[0].fplElementId,
        playerName: row[0].playerName,
        purchasePrice: row[0].purchasePrice,
        totalPoints,
      });
    }
    return result;
  };

  const offered = await buildTradePlayers(offeredPlayerIds ?? []);
  const requested = await buildTradePlayers(requestedPlayerIds ?? []);

  // Verify ownership: offered must belong to proposer, requested must belong to target
  for (const p of offered) {
    const own = await db.select().from(auctionOwnership).where(eq(auctionOwnership.id, p.ownershipId)).limit(1);
    if (own[0]?.teamId !== session.id) {
      return NextResponse.json({ error: `You don't own player ${p.playerName}` }, { status: 400 });
    }
  }
  for (const p of requested) {
    const own = await db.select().from(auctionOwnership).where(eq(auctionOwnership.id, p.ownershipId)).limit(1);
    if (own[0]?.teamId !== targetTeamId) {
      return NextResponse.json({ error: `Target doesn't own player ${p.playerName}` }, { status: 400 });
    }
  }

  // Get squad sizes and purses
  const proposerSquad = await db.select().from(auctionOwnership).where(
    and(eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.teamId, session.id), eq(auctionOwnership.status, "active"))
  );
  const targetSquad = await db.select().from(auctionOwnership).where(
    and(eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.teamId, targetTeamId), eq(auctionOwnership.status, "active"))
  );

  const proposerTeam = await db.select().from(teams).where(eq(teams.id, session.id)).limit(1);
  const targetTeam = await db.select().from(teams).where(eq(teams.id, targetTeamId)).limit(1);

  const validation = validateTradeProposal(
    offered,
    requested,
    cashOffered ?? 0,
    proposerSquad.length,
    targetSquad.length,
    proposerTeam[0]?.purse ?? 0,
    targetTeam[0]?.purse ?? 0,
    proposerTeam[0]?.penaltySlots ?? 0,
    targetTeam[0]?.penaltySlots ?? 0
  );

  if (!validation.valid) {
    return NextResponse.json({ error: "Trade validation failed", details: validation.errors }, { status: 400 });
  }

  const id = generateId();
  await db.insert(tradeProposals).values({
    id,
    leagueId,
    proposerTeamId: session.id,
    targetTeamId,
    offeredPlayerIds: JSON.stringify(offeredPlayerIds ?? []),
    requestedPlayerIds: JSON.stringify(requestedPlayerIds ?? []),
    cashOffered: cashOffered ?? 0,
    status: "pending",
  });

  return NextResponse.json({ success: true, proposalId: id });
}

/**
 * PATCH /api/auction/trade
 * Accept or reject a trade proposal.
 *
 * Body: { proposalId, action: "accept" | "reject" }
 */
export async function PATCH(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session || session.type !== "team") {
    return NextResponse.json({ error: "Team authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { proposalId, action } = body;

  if (!proposalId || !action || !["accept", "reject"].includes(action)) {
    return NextResponse.json({ error: "proposalId and action (accept/reject) are required" }, { status: 400 });
  }

  const proposalRow = await db
    .select()
    .from(tradeProposals)
    .where(eq(tradeProposals.id, proposalId))
    .limit(1);

  if (proposalRow.length === 0) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  const proposal = proposalRow[0];

  if (proposal.status !== "pending") {
    return NextResponse.json({ error: "Proposal is no longer pending" }, { status: 400 });
  }

  // Only the target team can accept/reject
  if (session.id !== proposal.targetTeamId) {
    return NextResponse.json({ error: "Only the target team can respond" }, { status: 403 });
  }

  if (action === "reject") {
    await db
      .update(tradeProposals)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(tradeProposals.id, proposalId));
    return NextResponse.json({ success: true, status: "rejected" });
  }

  // Accept — awaits admin approval (no veto window)
  await db
    .update(tradeProposals)
    .set({
      status: "accepted",
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, proposalId));

  return NextResponse.json({ success: true, status: "accepted" });
}
