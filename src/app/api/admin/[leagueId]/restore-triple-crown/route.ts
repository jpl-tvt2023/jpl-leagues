// POST /api/admin/[leagueId]/restore-triple-crown
//
// Triple-crown restore from a backup .zip or saved snapshot. Same shape as restore-tvt:
// preserves teams, wipes+restores fixtures. Triple-crown's cup-fixtures and UEFA knockouts are
// NOT in the backup payload today (tracked follow-up); only PL fixtures are restored.

import { NextRequest, NextResponse } from "next/server";
import { db, leagues } from "@/lib/db";
import { eq } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import {
  parseRestoreZip,
  loadRestoreSnapshot,
  restoreFixtures,
  RestoreGuardError,
  type RestorePayload,
} from "@/lib/backup/restore-tvt";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const leagueId = await getAuthorizedLeagueId(request);
  if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [league] = await db
    .select({ id: leagues.id, format: leagues.format })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);
  if (!league) return NextResponse.json({ error: "League not found" }, { status: 404 });
  if (league.format !== "triple-crown") {
    return NextResponse.json({ error: "Restore is for triple-crown leagues only" }, { status: 400 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  let payload: RestorePayload;
  try {
    if (contentType.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) {
        return NextResponse.json({ error: "Missing 'file' field in multipart body" }, { status: 400 });
      }
      const parsed = await parseRestoreZip(file);

      if (!parsed.meta) {
        return NextResponse.json(
          { error: "Backup zip is missing meta.json — please re-export from this league via Download Backup." },
          { status: 400 }
        );
      }
      if (parsed.meta.leagueId && parsed.meta.leagueId !== leagueId) {
        return NextResponse.json(
          { error: `League mismatch — this backup was taken from a different league (${parsed.meta.leagueSlug ?? parsed.meta.leagueId}). Restore aborted before any change.` },
          { status: 400 }
        );
      }
      if (parsed.meta.format && parsed.meta.format !== "triple-crown") {
        return NextResponse.json(
          { error: `Format mismatch — this backup is for a ${parsed.meta.format} league but the target is triple-crown.` },
          { status: 400 }
        );
      }
      payload = parsed;
    } else {
      const body = await request.json();
      const backupId = typeof body?.backupId === "string" ? body.backupId : null;
      if (!backupId) {
        return NextResponse.json({ error: "Provide either a multipart `file` upload or JSON `{ backupId }`" }, { status: 400 });
      }
      const parsed = await loadRestoreSnapshot(backupId, leagueId);
      if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 404 });
      payload = parsed;
    }
  } catch (err) {
    console.error("[restore-triple-crown] parse failed:", err);
    return NextResponse.json(
      { error: "Failed to parse backup", message: err instanceof Error ? err.message : "unknown" },
      { status: 400 }
    );
  }

  try {
    const result = await restoreFixtures(leagueId, payload);
    return NextResponse.json({
      success: true,
      fixturesInserted: result.inserted,
      warnings: result.warnings,
      message: `Restored ${result.inserted} PL fixture(s). Cup fixtures + UEFA knockouts are not in the backup payload yet — tracked follow-up. Captains restore deferred — use the Import Captain Data block if needed.`,
    });
  } catch (err) {
    if (err instanceof RestoreGuardError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[restore-triple-crown] apply failed:", err);
    return NextResponse.json(
      { error: "Restore failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
