import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { leagueAdmins } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Returns the leagueId from the request if the session has access to it.
 * - Superadmins have access to all leagues.
 * - Admins are checked against the leagueAdmins table.
 * Returns null if unauthorized or if leagueId is missing from headers.
 */
export async function getAuthorizedLeagueId(request: NextRequest): Promise<string | null> {
  const sessionType = request.headers.get("x-session-type");
  const sessionId = request.headers.get("x-session-id");
  const leagueId = request.headers.get("x-league-id");

  if (!leagueId || !sessionType || !sessionId) return null;

  if (sessionType === "superadmin") return leagueId;

  if (sessionType === "admin") {
    const rows = await db
      .select({ id: leagueAdmins.id })
      .from(leagueAdmins)
      .where(and(eq(leagueAdmins.userId, sessionId), eq(leagueAdmins.leagueId, leagueId)));
    return rows.length > 0 ? leagueId : null;
  }

  return null;
}
