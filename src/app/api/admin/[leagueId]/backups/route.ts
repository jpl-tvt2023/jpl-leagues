import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateId } from "@/lib/id";
import { generateBackupRows } from "@/lib/backup/generate";

/**
 * GET /api/admin/[leagueId]/backups
 *
 * List all stored backup snapshots for the league. Currently the only writer is
 * the GW1 auto-snapshot (`maybeWriteGw1Snapshot` in process-all.ts). Returned
 * shape is intentionally lean — JSON column blobs are NOT included; download a
 * specific snapshot via /api/admin/[leagueId]/backups/[backupId] to render xlsx.
 */
export async function GET(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await db
    .select({
      id: backups.id,
      trigger: backups.trigger,
      createdAt: backups.createdAt,
      hasTeams: backups.teamsJson,
      hasFixtures: backups.fixturesJson,
      hasCaptains: backups.captainsJson,
      hasChips: backups.chipsJson,
      hasAuctionTeamsState: backups.auctionTeamsStateJson,
      hasAuctionSquads: backups.auctionSquadsJson,
      hasAuctionClubs: backups.auctionClubsJson,
      hasGameweeks: backups.gameweeksJson,
      // Migration-0012 event-history columns. Including them in the
      // `includes` map so the UI can distinguish snapshots taken before vs
      // after the auction event-history migration. fixturesJson is .notNull()
      // so its truthiness flag is always true — we keep it for API stability
      // but it can no longer flip false.
      hasTrades: backups.tradesJson,
      hasPenaltyRedemptions: backups.penaltyRedemptionsJson,
      hasSlotUnlocks: backups.slotUnlocksJson,
      hasWishlists: backups.wishlistsJson,
      hasNotifications: backups.notificationsJson,
      hasAuctionSessions: backups.auctionSessionsJson,
      hasAuctionBids: backups.auctionBidsJson,
      hasAuctionBidLogs: backups.auctionBidLogsJson,
    })
    .from(backups)
    .where(eq(backups.leagueId, leagueId))
    .orderBy(desc(backups.createdAt));

  return NextResponse.json({
    backups: rows.map(r => ({
      id: r.id,
      trigger: r.trigger,
      createdAt: r.createdAt,
      // Boolean flags so the UI can show which files are inside without sending blobs.
      // fixtures is always true (NOT NULL column) — kept for API stability.
      includes: {
        teams: !!r.hasTeams,
        fixtures: !!r.hasFixtures,
        captains: !!r.hasCaptains,
        chips: !!r.hasChips,
        auctionTeamsState: !!r.hasAuctionTeamsState,
        auctionSquads: !!r.hasAuctionSquads,
        auctionClubs: !!r.hasAuctionClubs,
        gameweeks: !!r.hasGameweeks,
        // Migration-0012 auction event-history columns:
        auctionTrades: !!r.hasTrades,
        auctionPenaltyRedemptions: !!r.hasPenaltyRedemptions,
        auctionSlotUnlocks: !!r.hasSlotUnlocks,
        auctionWishlists: !!r.hasWishlists,
        auctionNotifications: !!r.hasNotifications,
        auctionSessions: !!r.hasAuctionSessions,
        auctionBids: !!r.hasAuctionBids,
        auctionBidLogs: !!r.hasAuctionBidLogs,
      },
    })),
  });
}

/**
 * POST /api/admin/[leagueId]/backups
 *
 * Create a manual snapshot of the league's current state. Distinct from the GET
 * /api/admin/[leagueId]/backup download (that's a one-shot file response with no
 * DB persistence). This endpoint persists a row in `backups` with `trigger: "manual"`
 * so admins have an audit trail and can restore later.
 *
 * No body required. Returns the new backup row's metadata.
 */
export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const rows = await generateBackupRows(leagueId);
    const id = generateId();
    const now = new Date();
    await db.insert(backups).values({
      id,
      leagueId,
      trigger: "manual",
      createdAt: now,
      teamsJson: rows.teams ? JSON.stringify(rows.teams) : null,
      fixturesJson: JSON.stringify(rows.fixtures),
      captainsJson: rows.captains ? JSON.stringify(rows.captains) : null,
      chipsJson: rows.chips ? JSON.stringify(rows.chips) : null,
      auctionTeamsStateJson: rows.auctionTeamsState ? JSON.stringify(rows.auctionTeamsState) : null,
      auctionSquadsJson: rows.auctionSquads ? JSON.stringify(rows.auctionSquads) : null,
      auctionClubsJson: rows.auctionClubs ? JSON.stringify(rows.auctionClubs) : null,
      gameweeksJson: JSON.stringify(rows.gameweeks),
      // Migration 0012 — auction event-history snapshots
      tradesJson: rows.auctionTrades ? JSON.stringify(rows.auctionTrades) : null,
      penaltyRedemptionsJson: rows.auctionPenaltyRedemptions ? JSON.stringify(rows.auctionPenaltyRedemptions) : null,
      slotUnlocksJson: rows.auctionSlotUnlocks ? JSON.stringify(rows.auctionSlotUnlocks) : null,
      wishlistsJson: rows.auctionWishlists ? JSON.stringify(rows.auctionWishlists) : null,
      notificationsJson: rows.auctionNotifications ? JSON.stringify(rows.auctionNotifications) : null,
      auctionSessionsJson: rows.auctionSessionsHistory ? JSON.stringify(rows.auctionSessionsHistory) : null,
      auctionBidsJson: rows.auctionBids ? JSON.stringify(rows.auctionBids) : null,
      auctionBidLogsJson: rows.auctionBidLogs ? JSON.stringify(rows.auctionBidLogs) : null,
    });
    return NextResponse.json({
      success: true,
      id,
      trigger: "manual",
      createdAt: now.toISOString(),
      counts: {
        fixtures: rows.fixtures.length,
        teams: rows.teams?.length ?? 0,
        auctionTeamsState: rows.auctionTeamsState?.length ?? 0,
        auctionSquads: rows.auctionSquads?.length ?? 0,
        auctionClubs: rows.auctionClubs?.length ?? 0,
        gameweeks: rows.gameweeks.length,
        auctionTrades: rows.auctionTrades?.length ?? 0,
        auctionPenaltyRedemptions: rows.auctionPenaltyRedemptions?.length ?? 0,
        auctionSlotUnlocks: rows.auctionSlotUnlocks?.length ?? 0,
        auctionWishlists: rows.auctionWishlists?.length ?? 0,
        auctionNotifications: rows.auctionNotifications?.length ?? 0,
        auctionSessions: rows.auctionSessionsHistory?.length ?? 0,
        auctionBids: rows.auctionBids?.length ?? 0,
        auctionBidLogs: rows.auctionBidLogs?.length ?? 0,
      },
    });
  } catch (err) {
    console.error("[backups POST] manual snapshot failed:", err);
    return NextResponse.json(
      { error: "Backup failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
