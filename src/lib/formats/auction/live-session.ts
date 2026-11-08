import { db, auctionSessions, tradeProposals, gameweeks } from "@/lib/db";
import { eq, and, or, inArray, isNotNull, asc, gt } from "drizzle-orm";
import { releaseCountdown, type ReleaseCountdown, type ScheduledMiniAuction } from "./release-deadline";

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
 * The league's next mini-auction that has a scheduled start and hasn't started yet — the one whose
 * release deadline (24h before it) confirms pending releases. Null when none is scheduled.
 */
export async function getNextMiniAuction(leagueId: string): Promise<ScheduledMiniAuction | null> {
  const [row] = await db
    .select({ cycleNumber: auctionSessions.cycleNumber, scheduledAt: auctionSessions.scheduledAt })
    .from(auctionSessions)
    .where(
      and(
        eq(auctionSessions.leagueId, leagueId),
        eq(auctionSessions.type, "mini-auction"),
        eq(auctionSessions.status, "pending"),
        isNotNull(auctionSessions.scheduledAt)
      )
    )
    .orderBy(asc(auctionSessions.scheduledAt))
    .limit(1);
  return row?.scheduledAt ? { cycleNumber: row.cycleNumber, scheduledAt: row.scheduledAt } : null;
}

/**
 * What the league's release timer counts down to: the next mini-auction's release deadline, or —
 * with none scheduled — the next GW deadline as a tentative placeholder.
 */
export async function loadReleaseCountdown(leagueId: string, now: Date = new Date()): Promise<ReleaseCountdown | null> {
  const nextMini = await getNextMiniAuction(leagueId);
  if (nextMini) return releaseCountdown(nextMini, null);
  const [nextGw] = await db
    .select({ number: gameweeks.number, deadline: gameweeks.deadline })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), gt(gameweeks.deadline, now)))
    .orderBy(asc(gameweeks.deadline))
    .limit(1);
  return releaseCountdown(null, nextGw ?? null);
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
