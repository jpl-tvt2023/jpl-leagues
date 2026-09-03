/**
 * GET /api/superadmin/fpl-classic/leagues
 *
 * The Operations tab's FPL Classic section. One row per fpl-classic league, with everything the
 * superadmin needs to decide whether to hit Process: entrant count, settled-through gameweek,
 * how many concluded gameweeks are still pending, and the last sync error if any.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, leagues } from "@/lib/db";
import { fplClassicConfig, fplClassicAwards } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { FPL_CLASSIC_FORMAT } from "@/lib/format-palette";
import { getActiveFplGameweek } from "@/lib/fpl/event-status";

export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const rows = await db
    .select({ id: leagues.id, slug: leagues.slug, name: leagues.name, season: leagues.season })
    .from(leagues)
    .where(eq(leagues.format, FPL_CLASSIC_FORMAT));

  const active = await getActiveFplGameweek().catch(() => null);
  const lastConcludedGw = active?.lastConcludedGw ?? 0;

  const out = await Promise.all(
    rows.map(async (league) => {
      const [config] = await db.select().from(fplClassicConfig).where(eq(fplClassicConfig.leagueId, league.id)).limit(1);
      const awardRows = await db.select({ scopeKey: fplClassicAwards.scopeKey }).from(fplClassicAwards).where(eq(fplClassicAwards.leagueId, league.id));
      const frozenScopeCount = new Set(awardRows.map((r) => r.scopeKey)).size;

      return {
        id: league.id,
        slug: league.slug,
        name: league.name,
        season: league.season,
        fplLeagueId: config?.fplLeagueId ?? null,
        entrantCount: config?.entrantCount ?? 0,
        settledThroughGw: config?.settledThroughGw ?? 0,
        lastConcludedGw,
        pendingGws: Math.max(0, lastConcludedGw - (config?.settledThroughGw ?? 0)),
        frozenScopeCount,
        entrantsSyncedAt: config?.entrantsSyncedAt ? config.entrantsSyncedAt.toISOString() : null,
        lastSyncError: config?.lastSyncError ?? null,
      };
    }),
  );

  return NextResponse.json({ leagues: out });
}
