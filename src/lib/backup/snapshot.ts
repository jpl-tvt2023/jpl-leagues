import { db } from "@/lib/db";
import { backups, auctionSessions } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { generateBackupRows } from "./generate";

/**
 * Write a snapshot of the league's full state + auction event-history, tagged
 * with the given `trigger` string. Idempotent: if a row with this exact
 * (leagueId, trigger) pair already exists we no-op so re-runs don't pile up
 * duplicate snapshots. The snapshot is stored as row arrays (not binary xlsx)
 * so the .zip is re-rendered at download time and naturally picks up future
 * formatting changes.
 */
export async function writeAutoSnapshot(leagueId: string, trigger: string): Promise<void> {
  const existing = await db
    .select({ id: backups.id })
    .from(backups)
    .where(and(eq(backups.leagueId, leagueId), eq(backups.trigger, trigger)))
    .limit(1);
  if (existing.length > 0) return;

  const rows = await generateBackupRows(leagueId);
  await db.insert(backups).values({
    id: generateId(),
    leagueId,
    trigger,
    teamsJson: rows.teams ? JSON.stringify(rows.teams) : null,
    fixturesJson: JSON.stringify(rows.fixtures),
    captainsJson: rows.captains ? JSON.stringify(rows.captains) : null,
    chipsJson: rows.chips ? JSON.stringify(rows.chips) : null,
    auctionTeamsStateJson: rows.auctionTeamsState ? JSON.stringify(rows.auctionTeamsState) : null,
    auctionSquadsJson: rows.auctionSquads ? JSON.stringify(rows.auctionSquads) : null,
    auctionClubsJson: rows.auctionClubs ? JSON.stringify(rows.auctionClubs) : null,
    gameweeksJson: JSON.stringify(rows.gameweeks),
    tradesJson: rows.auctionTrades ? JSON.stringify(rows.auctionTrades) : null,
    penaltyRedemptionsJson: rows.auctionPenaltyRedemptions ? JSON.stringify(rows.auctionPenaltyRedemptions) : null,
    slotUnlocksJson: rows.auctionSlotUnlocks ? JSON.stringify(rows.auctionSlotUnlocks) : null,
    wishlistsJson: rows.auctionWishlists ? JSON.stringify(rows.auctionWishlists) : null,
    notificationsJson: rows.auctionNotifications ? JSON.stringify(rows.auctionNotifications) : null,
    auctionSessionsJson: rows.auctionSessionsHistory ? JSON.stringify(rows.auctionSessionsHistory) : null,
    auctionBidsJson: rows.auctionBids ? JSON.stringify(rows.auctionBids) : null,
    auctionBidLogsJson: rows.auctionBidLogs ? JSON.stringify(rows.auctionBidLogs) : null,
  });
}

/**
 * Take a snapshot immediately after an auction session is marked completed.
 * Looks up the session's type + cycleNumber and builds a trigger string the UI
 * can render as a friendly label (see `formatBackupTrigger`):
 *   - initial      → `auction-initial-c0`
 *   - club-auction → `auction-club-c0`
 *   - mini-auction → `auction-mini-c{cycleNumber}`
 */
export async function writeAuctionCompleteSnapshot(sessionId: string): Promise<void> {
  const [s] = await db
    .select({
      leagueId: auctionSessions.leagueId,
      type: auctionSessions.type,
      cycleNumber: auctionSessions.cycleNumber,
    })
    .from(auctionSessions)
    .where(eq(auctionSessions.id, sessionId))
    .limit(1);
  if (!s) return;

  const trigger =
    s.type === "club-auction" ? "auction-club-c0"
      : s.type === "initial" ? "auction-initial-c0"
        : `auction-mini-c${s.cycleNumber}`;
  await writeAutoSnapshot(s.leagueId, trigger);
}
