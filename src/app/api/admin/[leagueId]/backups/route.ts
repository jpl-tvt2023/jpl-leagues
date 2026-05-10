import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

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
      includes: {
        teams: !!r.hasTeams,
        fixtures: !!r.hasFixtures,
        captains: !!r.hasCaptains,
        chips: !!r.hasChips,
      },
    })),
  });
}
