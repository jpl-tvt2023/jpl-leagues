import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateBackupRows } from "@/lib/backup/generate";
import { buildBackupZip, backupZipFilename } from "@/lib/backup/xlsx-zip";

export const maxDuration = 60;

/**
 * GET /api/admin/[leagueId]/backup
 *
 * Returns a single .zip with up to 4 .xlsx files reflecting CURRENT league state.
 * Each file is shaped to round-trip through its corresponding import endpoint.
 * For historical snapshots, see /api/admin/[leagueId]/backups (list) and
 * /api/admin/[leagueId]/backups/[backupId] (download a specific snapshot).
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const [league] = await db
      .select({ slug: leagues.slug })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    if (!league) return NextResponse.json({ error: "League not found" }, { status: 404 });

    const rows = await generateBackupRows(leagueId);
    const zipBuf = await buildBackupZip(rows);
    const filename = backupZipFilename(league.slug, new Date());

    return new NextResponse(zipBuf as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("backup route failed:", e);
    return NextResponse.json(
      { error: "Backup failed", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 }
    );
  }
}
