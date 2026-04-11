import { NextRequest, NextResponse } from "next/server";
import { db, teams, tradeProposals, auctionOwnership } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { checkVetoResult } from "@/lib/formats/auction/marketplace";

/**
 * POST /api/auction/trade/veto
 * Cast a veto or approve vote on an accepted trade proposal.
 *
 * Body: { proposalId, vote: "veto" | "approve" }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session || session.type !== "team") {
    return NextResponse.json({ error: "Team authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { proposalId, vote } = body;

  if (!proposalId || !vote || !["veto", "approve"].includes(vote)) {
    return NextResponse.json({ error: "proposalId and vote (veto/approve) are required" }, { status: 400 });
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

  if (proposal.status !== "accepted") {
    return NextResponse.json({ error: "Proposal is not in veto window" }, { status: 400 });
  }

  // Check veto deadline hasn't passed
  if (proposal.vetoDeadline && new Date() > proposal.vetoDeadline) {
    return NextResponse.json({ error: "Veto window has expired" }, { status: 400 });
  }

  // Cannot vote on your own trade
  if (session.id === proposal.proposerTeamId || session.id === proposal.targetTeamId) {
    return NextResponse.json({ error: "Involved teams cannot vote" }, { status: 403 });
  }

  // Verify voter is in the same league
  const voterTeam = await db.select().from(teams).where(eq(teams.id, session.id)).limit(1);
  if (voterTeam.length === 0 || voterTeam[0].leagueId !== proposal.leagueId) {
    return NextResponse.json({ error: "Not in this league" }, { status: 403 });
  }

  // Record vote
  const currentVotes: Record<string, "veto" | "approve"> = JSON.parse(proposal.vetoVotes);
  currentVotes[session.id] = vote;

  // Count total non-ghost teams in league
  const leagueTeams = await db
    .select()
    .from(teams)
    .where(and(eq(teams.leagueId, proposal.leagueId), eq(teams.isGhost, false)));

  const vetoResult = checkVetoResult(
    currentVotes,
    leagueTeams.length,
    proposal.proposerTeamId,
    proposal.targetTeamId
  );

  if (vetoResult.decided && vetoResult.vetoed) {
    // Trade vetoed
    await db
      .update(tradeProposals)
      .set({
        status: "vetoed",
        vetoVotes: JSON.stringify(currentVotes),
        updatedAt: new Date(),
      })
      .where(eq(tradeProposals.id, proposalId));

    return NextResponse.json({ success: true, status: "vetoed", vetoResult });
  }

  if (vetoResult.decided && !vetoResult.vetoed) {
    // Trade approved — execute it
    await executeTrade(proposal, currentVotes);
    return NextResponse.json({ success: true, status: "completed", vetoResult });
  }

  // Still undecided — just save the vote
  await db
    .update(tradeProposals)
    .set({
      vetoVotes: JSON.stringify(currentVotes),
      updatedAt: new Date(),
    })
    .where(eq(tradeProposals.id, proposalId));

  return NextResponse.json({ success: true, status: "pending_veto", vetoResult });
}

/**
 * Execute a trade: swap ownership of players and transfer cash.
 */
async function executeTrade(
  proposal: {
    id: string;
    leagueId: string;
    proposerTeamId: string;
    targetTeamId: string;
    offeredPlayerIds: string;
    requestedPlayerIds: string;
    cashOffered: number;
  },
  finalVotes: Record<string, "veto" | "approve">
) {
  const offeredIds: string[] = JSON.parse(proposal.offeredPlayerIds);
  const requestedIds: string[] = JSON.parse(proposal.requestedPlayerIds);

  await db.transaction(async (tx) => {
    // Transfer offered players (proposer → target)
    for (const id of offeredIds) {
      await tx
        .update(auctionOwnership)
        .set({ teamId: proposal.targetTeamId, updatedAt: new Date() })
        .where(eq(auctionOwnership.id, id));
    }

    // Transfer requested players (target → proposer)
    for (const id of requestedIds) {
      await tx
        .update(auctionOwnership)
        .set({ teamId: proposal.proposerTeamId, updatedAt: new Date() })
        .where(eq(auctionOwnership.id, id));
    }

    // Transfer cash
    if (proposal.cashOffered !== 0) {
      const proposerTeam = await tx.select().from(teams).where(eq(teams.id, proposal.proposerTeamId)).limit(1);
      const targetTeam = await tx.select().from(teams).where(eq(teams.id, proposal.targetTeamId)).limit(1);

      if (proposerTeam.length > 0 && targetTeam.length > 0) {
        await tx
          .update(teams)
          .set({
            purse: proposerTeam[0].purse - proposal.cashOffered,
            totalSpent: proposerTeam[0].totalSpent + Math.max(0, proposal.cashOffered),
            updatedAt: new Date(),
          })
          .where(eq(teams.id, proposal.proposerTeamId));

        await tx
          .update(teams)
          .set({
            purse: targetTeam[0].purse + proposal.cashOffered,
            totalIncome: targetTeam[0].totalIncome + Math.max(0, proposal.cashOffered),
            updatedAt: new Date(),
          })
          .where(eq(teams.id, proposal.targetTeamId));
      }
    }

    // Mark proposal as completed
    await tx
      .update(tradeProposals)
      .set({
        status: "accepted",
        vetoVotes: JSON.stringify(finalVotes),
        updatedAt: new Date(),
      })
      .where(eq(tradeProposals.id, proposal.id));
  });
}
