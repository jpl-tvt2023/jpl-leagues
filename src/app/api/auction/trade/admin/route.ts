import { NextRequest, NextResponse } from "next/server";
import { db, tradeProposals, auctionOwnership, teams, leagues, leagueAdmins } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { executeTrade } from "@/lib/formats/auction/trade";
import { validateTradeProposal, buildPositionMap, type TradePlayer } from "@/lib/formats/auction/marketplace";
import { createNotification, type NotificationType } from "@/lib/notifications";

async function notifyBothParties(
  proposal: { leagueId: string; proposerTeamId: string; targetTeamId: string },
  type: NotificationType,
  title: string,
  body: string,
  tab: "outgoing" | "incoming" | "history"
) {
  const leagueRow = await db
    .select({ slug: leagues.slug })
    .from(leagues)
    .where(eq(leagues.id, proposal.leagueId))
    .limit(1);
  const link = leagueRow[0] ? `/${leagueRow[0].slug}/marketplace?tab=${tab}` : undefined;
  await Promise.all([
    createNotification({ teamId: proposal.proposerTeamId, leagueId: proposal.leagueId, type, title, body, link }),
    createNotification({ teamId: proposal.targetTeamId, leagueId: proposal.leagueId, type, title, body, link }),
  ]);
}

/**
 * POST /api/auction/trade/admin
 * Admin trade actions: approve, reject, or cancel a trade proposal.
 *
 * Body: { proposalId, action: "approve" | "reject" | "cancel" }
 * Auth: superadmin only
 */
export async function POST(request: NextRequest) {
  // Initial gate: must be admin or superadmin session (block teams + anonymous).
  // The fine-grained league-admin scope check runs after we know the proposal's league.
  const sessionType = request.headers.get("x-session-type");
  const sessionId = request.headers.get("x-session-id");
  if (sessionType !== "superadmin" && sessionType !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { proposalId, action } = body;

  if (!proposalId || !action || !["approve", "reject", "cancel"].includes(action)) {
    return NextResponse.json(
      { error: "proposalId and action (approve/reject/cancel) are required" },
      { status: 400 }
    );
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

  // League-admin scoping: superadmins may act on any proposal; an admin must
  // have a leagueAdmins row for the proposal's leagueId. Matches the auth
  // shape used by /api/admin/[leagueId]/auction-corrections so league admins
  // have parity between low-level corrections (which read-modify the same
  // ownership rows) and trade-admin actions.
  if (sessionType === "admin") {
    if (!sessionId) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    const assigned = await db
      .select({ id: leagueAdmins.id })
      .from(leagueAdmins)
      .where(and(eq(leagueAdmins.userId, sessionId), eq(leagueAdmins.leagueId, proposal.leagueId)))
      .limit(1);
    if (assigned.length === 0) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
  }

  if (action === "approve") {
    // Only accepted proposals can be approved (target already agreed)
    if (proposal.status !== "accepted") {
      return NextResponse.json(
        { error: "Only accepted proposals can be approved. Current status: " + proposal.status },
        { status: 400 }
      );
    }

    // Re-validate with fresh squad/purse data before executing
    const [proposerSquad, targetSquad, proposerTeam, targetTeam] = await Promise.all([
      db.select().from(auctionOwnership).where(
        and(eq(auctionOwnership.leagueId, proposal.leagueId), eq(auctionOwnership.teamId, proposal.proposerTeamId), eq(auctionOwnership.status, "active"))
      ),
      db.select().from(auctionOwnership).where(
        and(eq(auctionOwnership.leagueId, proposal.leagueId), eq(auctionOwnership.teamId, proposal.targetTeamId), eq(auctionOwnership.status, "active"))
      ),
      db.select().from(teams).where(eq(teams.id, proposal.proposerTeamId)).limit(1),
      db.select().from(teams).where(eq(teams.id, proposal.targetTeamId)).limit(1),
    ]);

    const offeredIds: string[] = JSON.parse(proposal.offeredPlayerIds);
    const requestedIds: string[] = JSON.parse(proposal.requestedPlayerIds);
    const offeredFresh: TradePlayer[] = offeredIds.map((id) => {
      const o = proposerSquad.find((p) => p.id === id);
      return o ? { ownershipId: o.id, fplElementId: o.fplElementId, playerName: o.playerName, purchasePrice: o.purchasePrice, totalPoints: 0, elementType: o.elementType } : null;
    }).filter(Boolean) as TradePlayer[];
    const requestedFresh: TradePlayer[] = requestedIds.map((id) => {
      const o = targetSquad.find((p) => p.id === id);
      return o ? { ownershipId: o.id, fplElementId: o.fplElementId, playerName: o.playerName, purchasePrice: o.purchasePrice, totalPoints: 0, elementType: o.elementType } : null;
    }).filter(Boolean) as TradePlayer[];

    const revalidation = validateTradeProposal(
      offeredFresh,
      requestedFresh,
      proposal.cashOffered,
      proposerSquad.length,
      targetSquad.length,
      proposerTeam[0]?.purse ?? 0,
      targetTeam[0]?.purse ?? 0,
      proposerTeam[0]?.penaltySlots ?? 0,
      targetTeam[0]?.penaltySlots ?? 0,
      buildPositionMap(proposerSquad),
      buildPositionMap(targetSquad),
      proposerTeam[0]?.bonusSlots ?? 0,
      targetTeam[0]?.bonusSlots ?? 0,
    );

    if (!revalidation.valid) {
      return NextResponse.json(
        { error: "Trade is no longer valid (squads may have changed since acceptance)", details: revalidation.errors },
        { status: 400 }
      );
    }

    await executeTrade({
      id: proposal.id,
      leagueId: proposal.leagueId,
      proposerTeamId: proposal.proposerTeamId,
      targetTeamId: proposal.targetTeamId,
      offeredPlayerIds: proposal.offeredPlayerIds,
      requestedPlayerIds: proposal.requestedPlayerIds,
      cashOffered: proposal.cashOffered,
    });

    await notifyBothParties(
      proposal,
      "trade_approved",
      "Trade approved",
      "Admin approved the trade — players & cash have been transferred",
      "history"
    );

    return NextResponse.json({ success: true, status: "completed" });
  }

  if (action === "reject") {
    if (proposal.status !== "pending" && proposal.status !== "accepted") {
      return NextResponse.json(
        { error: "Can only reject pending or accepted proposals. Current status: " + proposal.status },
        { status: 400 }
      );
    }

    await db
      .update(tradeProposals)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(eq(tradeProposals.id, proposalId));

    await notifyBothParties(
      proposal,
      "trade_admin_rejected",
      "Trade rejected by admin",
      "Admin rejected the trade",
      "history"
    );

    return NextResponse.json({ success: true, status: "rejected" });
  }

  // cancel
  if (proposal.status === "completed") {
    return NextResponse.json({ error: "Cannot cancel a completed trade" }, { status: 400 });
  }

  await db
    .update(tradeProposals)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(tradeProposals.id, proposalId));

  await notifyBothParties(
    proposal,
    "trade_cancelled",
    "Trade cancelled",
    "Admin cancelled the trade",
    "history"
  );

  return NextResponse.json({ success: true, status: "cancelled" });
}
