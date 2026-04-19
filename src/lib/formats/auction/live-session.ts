import { db, auctionSessions, tradeProposals } from "@/lib/db";
import { eq, and, or, inArray } from "drizzle-orm";

/**
 * Returns true when the league has any active or paused auction session.
 * Used to lock the marketplace while a live auction is in progress.
 */
export async function isAuctionLive(leagueId: string): Promise<boolean> {
  const rows = await db
    .select({ id: auctionSessions.id })
    .from(auctionSessions)
    .where(
      and(
        eq(auctionSessions.leagueId, leagueId),
        or(eq(auctionSessions.status, "active"), eq(auctionSessions.status, "paused"))
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Cancel every non-completed/non-cancelled trade proposal in the league.
 * Invoked once when an auction session transitions to active.
 */
export async function purgePendingTrades(leagueId: string): Promise<number> {
  const open = await db
    .select({ id: tradeProposals.id })
    .from(tradeProposals)
    .where(
      and(
        eq(tradeProposals.leagueId, leagueId),
        inArray(tradeProposals.status, ["pending", "accepted"])
      )
    );

  if (open.length === 0) return 0;

  await db
    .update(tradeProposals)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(inArray(tradeProposals.id, open.map((r) => r.id)));

  return open.length;
}
