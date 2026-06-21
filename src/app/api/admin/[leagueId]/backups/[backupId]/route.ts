import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { backups, leagues } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { buildBackupZip, backupZipFilename } from "@/lib/backup/xlsx-zip";
import type { BackupRows } from "@/lib/backup/generate";

interface RouteParams {
  params: Promise<{ leagueId: string; backupId: string }>;
}

export const maxDuration = 60;

/**
 * GET /api/admin/[leagueId]/backups/[backupId]
 *
 * Download a specific historical snapshot as a .zip. The snapshot was stored as
 * row arrays (NOT binary xlsx) so we re-render via `buildBackupZip` here — that
 * means future formatting changes naturally apply to old snapshots without any
 * data migration.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { backupId } = await params;

  const [row] = await db
    .select()
    .from(backups)
    .where(and(eq(backups.id, backupId), eq(backups.leagueId, leagueId)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Backup not found" }, { status: 404 });

  const [league] = await db
    .select({ slug: leagues.slug, name: leagues.name, format: leagues.format, season: leagues.season })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) return NextResponse.json({ error: "League not found" }, { status: 404 });

  // Re-hydrate the stored JSON into the BackupRows shape that `buildBackupZip` expects.
  // Synthesise the meta from the current league row + the snapshot's createdAt. Older snapshots
  // don't carry their own meta in the backups table, so we infer the snapshot's ORIGINAL format
  // from which JSON columns are populated:
  //   auctionSquadsJson != null  →  inferred "auction"
  //   chipsJson != null          →  inferred "tvt"
  //   otherwise                  →  inferred "continental-championship" (or other non-tvt, non-auction format)
  // If the inferred format differs from the current league.format the league was re-formatted after
  // this backup was taken — `inferredOriginalFormat` exposes the drift so restore tooling can
  // refuse with a meaningful error instead of silently misinterpreting the payload.
  const inferredOriginalFormat: string =
    row.auctionSquadsJson != null ? "auction"
    : row.chipsJson != null ? "tvt"
    : league.format === "auction" || league.format === "tvt"
      ? "continental-championship"
      : league.format;
  const rows: BackupRows = {
    meta: {
      leagueId,
      leagueSlug: league.slug,
      leagueName: league.name,
      format: league.format,
      season: league.season,
      generatedAt: new Date(row.createdAt).toISOString(),
      backupVersion: 1,
      // Drift signal — see comment above. Equal to format on a non-drifted league.
      inferredOriginalFormat,
    },
    format: league.format,
    teams: row.teamsJson ? JSON.parse(row.teamsJson) : null,
    fixtures: row.fixturesJson ? JSON.parse(row.fixturesJson) : [],
    captains: row.captainsJson ? JSON.parse(row.captainsJson) : null,
    chips: row.chipsJson ? JSON.parse(row.chipsJson) : null,
    auctionTeamsState: row.auctionTeamsStateJson ? JSON.parse(row.auctionTeamsStateJson) : null,
    auctionSquads: row.auctionSquadsJson ? JSON.parse(row.auctionSquadsJson) : null,
    auctionClubs: row.auctionClubsJson ? JSON.parse(row.auctionClubsJson) : null,
    gameweeks: row.gameweeksJson ? JSON.parse(row.gameweeksJson) : [],
    // Migration 0012 — auction event-history snapshots. `null` for pre-PR rows.
    auctionTrades: row.tradesJson ? JSON.parse(row.tradesJson) : null,
    auctionPenaltyRedemptions: row.penaltyRedemptionsJson ? JSON.parse(row.penaltyRedemptionsJson) : null,
    auctionSlotUnlocks: row.slotUnlocksJson ? JSON.parse(row.slotUnlocksJson) : null,
    auctionWishlists: row.wishlistsJson ? JSON.parse(row.wishlistsJson) : null,
    auctionNotifications: row.notificationsJson ? JSON.parse(row.notificationsJson) : null,
    auctionSessionsHistory: row.auctionSessionsJson ? JSON.parse(row.auctionSessionsJson) : null,
    auctionBids: row.auctionBidsJson ? JSON.parse(row.auctionBidsJson) : null,
    auctionBidLogs: row.auctionBidLogsJson ? JSON.parse(row.auctionBidLogsJson) : null,
  };

  const zipBuf = await buildBackupZip(rows);
  const stamp = new Date(row.createdAt);
  const filename = backupZipFilename(`${league.slug}-${row.trigger}`, stamp);

  return new NextResponse(zipBuf as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * DELETE /api/admin/[leagueId]/backups/[backupId]
 *
 * Remove a single backup snapshot row. The (id, leagueId) pair is enforced in the
 * WHERE clause so an admin cannot delete a row belonging to another league.
 * `backups` is a leaf table (no FK references in), so the delete cascades to nothing.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { backupId } = await params;

  const [row] = await db
    .select({ id: backups.id })
    .from(backups)
    .where(and(eq(backups.id, backupId), eq(backups.leagueId, leagueId)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Backup not found" }, { status: 404 });

  await db
    .delete(backups)
    .where(and(eq(backups.id, backupId), eq(backups.leagueId, leagueId)));

  return NextResponse.json({ success: true });
}
