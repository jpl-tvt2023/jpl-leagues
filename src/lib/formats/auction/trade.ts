// JPL Auction — Trade Execution
// Shared logic for executing an accepted trade (player swap + cash transfer)

import { db } from "@/lib/db";
import { auctionOwnership, teams, tradeProposals } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export interface TradeProposalForExecution {
  id: string;
  leagueId: string;
  proposerTeamId: string;
  targetTeamId: string;
  offeredPlayerIds: string;
  requestedPlayerIds: string;
  cashOffered: number;
}

/**
 * Execute a trade: swap ownership of players and transfer cash.
 * Called by admin approve endpoint.
 *
 * Atomic transaction:
 * 1. Transfer offered players (proposer → target)
 * 2. Transfer requested players (target → proposer)
 * 3. Transfer cash between purses
 * 4. Mark proposal as completed
 */
export async function executeTrade(proposal: TradeProposalForExecution): Promise<void> {
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
        status: "completed",
        updatedAt: new Date(),
      })
      .where(eq(tradeProposals.id, proposal.id));
  });
}
