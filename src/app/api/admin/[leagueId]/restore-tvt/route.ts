// POST /api/admin/[leagueId]/restore-tvt
//
// TVT restore from a backup .zip or saved snapshot. Mirrors the auction restore semantics:
// preserves teams (no wipe of accounts/passwords), restores fixtures (wipes-then-inserts; results
// cascade-deleted along with fixtures). Captains + chips restore is a tracked follow-up; admins
// continue to use the legacy per-file upload blocks for those.
//
// Cross-league + format guards live at the top — no destructive operation runs until they pass.

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
  if (league.format !== "tvt") {
    return NextResponse.json({ error: "Restore is for TVT-format leagues only" }, { status: 400 });
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

      // Cross-league + format guard — reject before any destructive op.
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
      if (parsed.meta && parsed.meta.format && parsed.meta.format !== "tvt") {
        return NextResponse.json(
          { error: `Format mismatch — this backup is for a ${parsed.meta.format} league but the target is TVT.` },
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
      // Cross-format guard for the saved-snapshot path — mirror the multipart
      // guard above. The inferred original format comes from which JSON
      // columns are populated in the backups row (see loadRestoreSnapshot).
      if (parsed.meta && parsed.meta.format && parsed.meta.format !== "tvt") {
        return NextResponse.json(
          { error: `Format mismatch — this backup is for a ${parsed.meta.format} league but the target is TVT.` },
          { status: 400 }
        );
      }
      payload = parsed;
    }
  } catch (err) {
    console.error("[restore-tvt] parse failed:", err);
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
      message: `Restored ${result.inserted} fixture(s). Captains + chips restore is a tracked follow-up — use the Import Captain/Chip Data blocks if those need to be applied.`,
    });
  } catch (err) {
    if (err instanceof RestoreGuardError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[restore-tvt] apply failed:", err);
    return NextResponse.json(
      { error: "Restore failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
