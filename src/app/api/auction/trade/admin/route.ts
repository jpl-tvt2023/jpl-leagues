import { NextRequest, NextResponse } from "next/server";
import { db, tradeProposals } from "@/lib/db";
import { eq } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { executeTrade } from "@/lib/formats/auction/trade";

/**
 * POST /api/auction/trade/admin
 * Admin trade actions: approve, reject, or cancel a trade proposal.
 *
 * Body: { proposalId, action: "approve" | "reject" | "cancel" }
 * Auth: superadmin only
 */
export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
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

  if (action === "approve") {
    // Only accepted proposals can be approved (target already agreed)
    if (proposal.status !== "accepted") {
      return NextResponse.json(
        { error: "Only accepted proposals can be approved. Current status: " + proposal.status },
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

  return NextResponse.json({ success: true, status: "cancelled" });
}
