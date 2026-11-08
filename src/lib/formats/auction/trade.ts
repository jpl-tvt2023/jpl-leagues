// JPL Auction — Trade Execution
// Shared logic for executing an accepted trade (player swap + cash transfer)

import { db } from "@/lib/db";
import { auctionOwnership, teams, tradeProposals } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { getStartedGameweekNumber } from "@/lib/gameweeks/current-gw";

// 5% of cash received is charged to the receiving team
const TRANSFER_FEE_RATE = 0.05;

/** The trade can't run as approved: already executed, no longer accepted, or a squad changed. */
export class TradeNoLongerValidError extends Error {}

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
 * 1. Claim the proposal (accepted → completed), so approving twice can't run it twice
 * 2. Move offered players (proposer → target) and requested players (target → proposer)
 * 3. Transfer cash between purses
 *
 * A move keeps ownership history. Scoring credits a player by each row's acquired/released window,
 * so the seller keeps a closed copy of the row (status "transferred", ending at this gameweek) and
 * the row itself moves on to the buyer, scoring from the next gameweek — the same rule as releases
 * and mini-auction buys. Reprocessing a gameweek from before the trade then credits the seller,
 * and the seller's ledger keeps his purchase while the buyer's shows none (acquiredVia "trade").
 *
 * Throws TradeNoLongerValidError, changing nothing, if any player is no longer the expected team's
 * active squad member.
 */
export async function executeTrade(proposal: TradeProposalForExecution): Promise<void> {
  const offeredIds: string[] = JSON.parse(proposal.offeredPlayerIds);
  const requestedIds: string[] = JSON.parse(proposal.requestedPlayerIds);
  const moves = [
    ...offeredIds.map((id) => ({ id, from: proposal.proposerTeamId, to: proposal.targetTeamId })),
    ...requestedIds.map((id) => ({ id, from: proposal.targetTeamId, to: proposal.proposerTeamId })),
  ];
  const gw = await getStartedGameweekNumber(proposal.leagueId);
  const now = new Date();

  // libsql opens this as BEGIN IMMEDIATE, so nothing else writes between the checks and the moves.
  await db.transaction(async (tx) => {
    const claimed = await tx
      .update(tradeProposals)
      .set({ status: "completed", updatedAt: now })
      .where(and(eq(tradeProposals.id, proposal.id), eq(tradeProposals.status, "accepted")))
      .returning({ id: tradeProposals.id });
    if (claimed.length === 0) {
      throw new TradeNoLongerValidError("This trade has already been executed or is no longer accepted");
    }

    for (const move of moves) {
      const [row] = await tx.select().from(auctionOwnership).where(eq(auctionOwnership.id, move.id)).limit(1);
      if (!row || row.leagueId !== proposal.leagueId || row.teamId !== move.from || row.status !== "active") {
        throw new TradeNoLongerValidError(
          `${row?.playerName ?? "A player in this trade"} is no longer in the squad it was offered from`
        );
      }
      // The seller's window, closed at this gameweek.
      await tx.insert(auctionOwnership).values({ ...row, id: generateId(), status: "transferred", releasedGw: gw, updatedAt: now });
      // The row itself moves on. It keeps its id, so the proposal — and the ledger line that names
      // its players — still points at it.
      await tx
        .update(auctionOwnership)
        .set({ teamId: move.to, acquiredGw: gw, acquiredVia: "trade", updatedAt: now })
        .where(eq(auctionOwnership.id, row.id));
    }

    // Transfer cash with 5% fee on the receiving team
    if (proposal.cashOffered !== 0) {
      const proposerTeam = await tx.select().from(teams).where(eq(teams.id, proposal.proposerTeamId)).limit(1);
      const targetTeam = await tx.select().from(teams).where(eq(teams.id, proposal.targetTeamId)).limit(1);

      if (proposerTeam.length > 0 && targetTeam.length > 0) {
        if (proposal.cashOffered > 0) {
          // Target receives cash — charge 5% fee on received amount
          const fee = Math.round(proposal.cashOffered * TRANSFER_FEE_RATE);
          const netReceived = proposal.cashOffered - fee;

          await tx
            .update(teams)
            .set({
              purse: proposerTeam[0].purse - proposal.cashOffered,
              totalSpent: proposerTeam[0].totalSpent + proposal.cashOffered,
              updatedAt: new Date(),
            })
            .where(eq(teams.id, proposal.proposerTeamId));

          await tx
            .update(teams)
            .set({
              purse: targetTeam[0].purse + netReceived,
              totalIncome: targetTeam[0].totalIncome + netReceived,
              updatedAt: new Date(),
            })
            .where(eq(teams.id, proposal.targetTeamId));
        } else {
          // Proposer receives cash (cashOffered < 0) — charge 5% fee on received amount
          const grossReceived = -proposal.cashOffered;
          const fee = Math.round(grossReceived * TRANSFER_FEE_RATE);
          const netReceived = grossReceived - fee;

          await tx
            .update(teams)
            .set({
              purse: targetTeam[0].purse - grossReceived,
              totalSpent: targetTeam[0].totalSpent + grossReceived,
              updatedAt: new Date(),
            })
            .where(eq(teams.id, proposal.targetTeamId));

          await tx
            .update(teams)
            .set({
              purse: proposerTeam[0].purse + netReceived,
              totalIncome: proposerTeam[0].totalIncome + netReceived,
              updatedAt: new Date(),
            })
            .where(eq(teams.id, proposal.proposerTeamId));
        }
      }
    }
  });
}
