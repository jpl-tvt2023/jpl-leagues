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
    .select({ slug: leagues.slug, format: leagues.format })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) return NextResponse.json({ error: "League not found" }, { status: 404 });

  // Re-hydrate the stored JSON into the BackupRows shape that `buildBackupZip` expects.
  const rows: BackupRows = {
    format: league.format,
    teams: row.teamsJson ? JSON.parse(row.teamsJson) : null,
    fixtures: row.fixturesJson ? JSON.parse(row.fixturesJson) : [],
    captains: row.captainsJson ? JSON.parse(row.captainsJson) : null,
    chips: row.chipsJson ? JSON.parse(row.chipsJson) : null,
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
