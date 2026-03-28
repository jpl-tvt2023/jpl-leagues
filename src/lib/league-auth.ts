import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { leagueAdmins, leagues } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Returns the leagueId (UUID) from the request if the session has access to it.
 * The URL segment may be a slug — resolves it to the UUID automatically.
 * - Superadmins have access to all leagues (active or inactive).
 * - Admins are checked against the leagueAdmins table AND the league must be active.
 * Returns null if unauthorized, league is inactive (for admins), or leagueId is missing.
 */
export async function getAuthorizedLeagueId(request: NextRequest): Promise<string | null> {
  const sessionType = request.headers.get("x-session-type");
  const sessionId = request.headers.get("x-session-id");
  const leagueParam = request.headers.get("x-league-id");

  if (!leagueParam || !sessionType || !sessionId) return null;

  // Resolve slug → UUID (UUIDs contain hyphens in a specific pattern; slugs don't match)
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leagueParam);
  let leagueId: string;

  if (isUuid) {
    leagueId = leagueParam;
  } else {
    // Look up by slug
    const row = await db
      .select({ id: leagues.id, isActive: leagues.isActive })
      .from(leagues)
      .where(eq(leagues.slug, leagueParam))
      .limit(1);
    if (!row[0]) return null;
    leagueId = row[0].id;
  }

  if (sessionType === "superadmin") return leagueId;

  if (sessionType === "admin") {
    const rows = await db
      .select({ id: leagueAdmins.id })
      .from(leagueAdmins)
      .where(and(eq(leagueAdmins.userId, sessionId), eq(leagueAdmins.leagueId, leagueId)));
    if (rows.length === 0) return null;

    // Block access to inactive leagues
    const league = await db
      .select({ isActive: leagues.isActive })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    return league[0]?.isActive ? leagueId : null;
  }

  return null;
}
