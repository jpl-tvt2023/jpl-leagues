import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateBackupRows } from "@/lib/backup/generate";

export const maxDuration = 60;

/**
 * GET /api/admin/[leagueId]/backup
 *
 * Returns a single .zip containing up to 4 .xlsx files, each shaped to match
 * the corresponding import endpoint:
 *   - teams.xlsx     (skipped for auction format)
 *   - fixtures.xlsx
 *   - captains.xlsx  (skipped for auction format)
 *   - chips.xlsx     (only for tvt format)
 *
 * The xlsx files round-trip through their respective import endpoints — restore
 * by uploading each file via the matching block on the Bulk Upload tab.
 *
 * Note: passwords are emitted as a placeholder ("RESET_REQUIRED"). Plaintext
 * passwords are not recoverable from bcrypt hashes; admin must hand out new
 * credentials or use per-team edit on restore.
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

    const zip = new JSZip();
    if (rows.teams) {
      zip.file("teams.xlsx", buildXlsxBuffer(rows.teams, "Teams"));
    }
    zip.file("fixtures.xlsx", buildXlsxBuffer(rows.fixtures, "Fixtures"));
    if (rows.captains) {
      zip.file("captains.xlsx", buildXlsxBuffer(rows.captains, "Captains"));
    }
    if (rows.chips) {
      zip.file("chips.xlsx", buildXlsxBuffer(rows.chips, "Chips"));
    }

    const zipBuf = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });

    const stamp = formatTimestamp(new Date());
    const filename = `backup-${league.slug}-${stamp}.zip`;

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

function buildXlsxBuffer(rows: Record<string, unknown>[], sheetName: string): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
