import { NextRequest, NextResponse } from "next/server";
import { db, teams, leagues, auctionOwnership, tradeProposals, auctionScores } from "@/lib/db";
import { eq, and, or, lt } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";
import { validateTradeProposal, buildPositionMap, type TradePlayer } from "@/lib/formats/auction/marketplace";
import { calculateFMV } from "@/lib/formats/auction/economy";
import { isAuctionLive } from "@/lib/formats/auction/live-session";
import { createNotification } from "@/lib/notifications";
import { fetchClubOwnershipMap } from "@/lib/teams/rename-rows";

const TRADE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Mark pending proposals older than 24h as "expired". Called lazily on every read.
 */
async function expireStaleProposals(leagueId: string) {
  const cutoff = new Date(Date.now() - TRADE_EXPIRY_MS);
  await db
    .update(tradeProposals)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(tradeProposals.leagueId, leagueId),
        eq(tradeProposals.status, "pending"),
        lt(tradeProposals.createdAt, cutoff)
      )
    );
}

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
  const scope = request.nextUrl.searchParams.get("scope");

  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  // Lazy expiry — mark pending proposals older than 24h as "expired" before reading.
  await expireStaleProposals(leagueId);

  let proposals;
  if (scope === "public") {
    // League-wide live offers (pending or accepted only); excludes the caller's own trades.
    const baseRows = await db
      .select()
      .from(tradeProposals)
      .where(eq(tradeProposals.leagueId, leagueId));
    proposals = baseRows.filter((p) => {
      if (p.status !== "pending" && p.status !== "accepted") return false;
      if (session.type === "team" && (p.proposerTeamId === session.id || p.targetTeamId === session.id)) return false;
      return true;
    });
  } else if (teamId) {
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

  // Tier gate: Primary tier excludes trades entirely. UI hides the page; this enforces it server-side.
  if (leagueRow[0].auctionTier === "primary") {
    return NextResponse.json({ error: "Trades are not available in Primary tier" }, { status: 403 });
  }

  if (await isAuctionLive(leagueId)) {
    return NextResponse.json(
      { error: "Marketplace is closed during a live auction" },
      { status: 409 }
    );
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

  const proposerPositions = buildPositionMap(proposerSquad);
  const targetPositions = buildPositionMap(targetSquad);

  const validation = validateTradeProposal(
    offered,
    requested,
    cashOffered ?? 0,
    proposerSquad.length,
    targetSquad.length,
    proposerTeam[0]?.purse ?? 0,
    targetTeam[0]?.purse ?? 0,
    proposerTeam[0]?.penaltySlots ?? 0,
    targetTeam[0]?.penaltySlots ?? 0,
    proposerPositions,
    targetPositions,
    proposerTeam[0]?.bonusSlots ?? 0,
    targetTeam[0]?.bonusSlots ?? 0,
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

  // PL Club Auction rename — notification body shows the proposer's club name if they own one.
  const clubByTeamId = await fetchClubOwnershipMap(leagueId);
  const proposerDisplay = clubByTeamId.get(session.id)?.plTeamName ?? proposerTeam[0]?.name ?? "A team";
  await createNotification({
    teamId: targetTeamId,
    leagueId,
    type: "trade_proposed",
    title: "New trade proposal",
    body: `${proposerDisplay} sent you a trade proposal`,
    link: `/${leagueRow[0].slug}/marketplace?tab=incoming`,
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

  // Lazy expiry: if pending but past 24h, flip to expired and refuse.
  const ageMs = Date.now() - new Date(proposal.createdAt).getTime();
  if (proposal.status === "pending" && ageMs > TRADE_EXPIRY_MS) {
    await db.update(tradeProposals)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(tradeProposals.id, proposalId));
    return NextResponse.json({ error: "Proposal expired (24h limit)" }, { status: 410 });
  }

  if (proposal.status !== "pending") {
    return NextResponse.json({ error: "Proposal is no longer pending" }, { status: 400 });
  }

  // Tier gate: Primary tier excludes trades. Pending proposals from before a tier change still
  // can't be accepted/rejected — they remain pending until they expire.
  const leagueTierRow = await db.select({ auctionTier: leagues.auctionTier }).from(leagues).where(eq(leagues.id, proposal.leagueId)).limit(1);
  if (leagueTierRow[0]?.auctionTier === "primary") {
    return NextResponse.json({ error: "Trades are not available in Primary tier" }, { status: 403 });
  }

  if (await isAuctionLive(proposal.leagueId)) {
    return NextResponse.json(
      { error: "Marketplace is closed during a live auction" },
      { status: 409 }
    );
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

    const [leagueRow, targetRow, clubByTeamIdRej] = await Promise.all([
      db.select({ slug: leagues.slug }).from(leagues).where(eq(leagues.id, proposal.leagueId)).limit(1),
      db.select({ name: teams.name }).from(teams).where(eq(teams.id, proposal.targetTeamId)).limit(1),
      fetchClubOwnershipMap(proposal.leagueId),
    ]);
    const targetDisplay = clubByTeamIdRej.get(proposal.targetTeamId)?.plTeamName ?? targetRow[0]?.name ?? "The other team";
    await createNotification({
      teamId: proposal.proposerTeamId,
      leagueId: proposal.leagueId,
      type: "trade_rejected",
      title: "Trade rejected",
      body: `${targetDisplay} rejected your trade proposal`,
      link: leagueRow[0] ? `/${leagueRow[0].slug}/marketplace?tab=outgoing` : undefined,
    });
    return NextResponse.json({ success: true, status: "rejected" });
  }

  // Accept — re-validate with fresh squad/purse data before accepting
  const [proposerSquadFresh, targetSquadFresh, proposerTeamFresh, targetTeamFresh] = await Promise.all([
    db.select().from(auctionOwnership).where(
      and(eq(auctionOwnership.leagueId, proposal.leagueId), eq(auctionOwnership.teamId, proposal.proposerTeamId), eq(auctionOwnership.status, "active"))
    ),
    db.select().from(auctionOwnership).where(
      and(eq(auctionOwnership.leagueId, proposal.leagueId), eq(auctionOwnership.teamId, proposal.targetTeamId), eq(auctionOwnership.status, "active"))
    ),
    db.select().from(teams).where(eq(teams.id, proposal.proposerTeamId)).limit(1),
    db.select().from(teams).where(eq(teams.id, proposal.targetTeamId)).limit(1),
  ]);

  // Rebuild offered/requested as TradePlayer arrays from the stored ownership IDs
  const offeredIds: string[] = JSON.parse(proposal.offeredPlayerIds);
  const requestedIds: string[] = JSON.parse(proposal.requestedPlayerIds);
  const offeredFresh: TradePlayer[] = offeredIds.map((id) => {
    const o = proposerSquadFresh.find((p) => p.id === id);
    return o ? { ownershipId: o.id, fplElementId: o.fplElementId, playerName: o.playerName, purchasePrice: o.purchasePrice, totalPoints: 0, elementType: o.elementType } : null;
  }).filter(Boolean) as TradePlayer[];
  const requestedFresh: TradePlayer[] = requestedIds.map((id) => {
    const o = targetSquadFresh.find((p) => p.id === id);
    return o ? { ownershipId: o.id, fplElementId: o.fplElementId, playerName: o.playerName, purchasePrice: o.purchasePrice, totalPoints: 0, elementType: o.elementType } : null;
  }).filter(Boolean) as TradePlayer[];

  const revalidation = validateTradeProposal(
    offeredFresh,
    requestedFresh,
    proposal.cashOffered,
    proposerSquadFresh.length,
    targetSquadFresh.length,
    proposerTeamFresh[0]?.purse ?? 0,
    targetTeamFresh[0]?.purse ?? 0,
    proposerTeamFresh[0]?.penaltySlots ?? 0,
    targetTeamFresh[0]?.penaltySlots ?? 0,
    buildPositionMap(proposerSquadFresh),
    buildPositionMap(targetSquadFresh),
    proposerTeamFresh[0]?.bonusSlots ?? 0,
    targetTeamFresh[0]?.bonusSlots ?? 0,
  );

  if (!revalidation.valid) {
    return NextResponse.json(
      { error: "Trade is no longer valid (squads may have changed)", details: revalidation.errors },
      { status: 400 }
    );
  }

  await db
    .update(tradeProposals)
    .set({ status: "accepted", updatedAt: new Date() })
    .where(eq(tradeProposals.id, proposalId));

  const [leagueAcceptRow, targetAcceptRow, clubByTeamIdAcc] = await Promise.all([
    db.select({ slug: leagues.slug }).from(leagues).where(eq(leagues.id, proposal.leagueId)).limit(1),
    db.select({ name: teams.name }).from(teams).where(eq(teams.id, proposal.targetTeamId)).limit(1),
    fetchClubOwnershipMap(proposal.leagueId),
  ]);
  const targetAcceptDisplay = clubByTeamIdAcc.get(proposal.targetTeamId)?.plTeamName ?? targetAcceptRow[0]?.name ?? "The other team";
  await createNotification({
    teamId: proposal.proposerTeamId,
    leagueId: proposal.leagueId,
    type: "trade_accepted",
    title: "Trade accepted",
    body: `${targetAcceptDisplay} accepted your trade — awaiting admin approval`,
    link: leagueAcceptRow[0] ? `/${leagueAcceptRow[0].slug}/marketplace?tab=outgoing` : undefined,
  });

  return NextResponse.json({ success: true, status: "accepted" });
}
