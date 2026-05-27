import { NextRequest, NextResponse } from "next/server";
import { db, feedback } from "@/lib/db";
import { eq, and, desc } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * GET /api/admin/[leagueId]/feedback
 * Returns league-scoped feedback rows for the given league. League admins +
 * superadmins only (via getAuthorizedLeagueId).
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rows = await db
      .select()
      .from(feedback)
      .where(and(eq(feedback.scope, "league"), eq(feedback.leagueId, leagueId)))
      .orderBy(desc(feedback.createdAt));

    return NextResponse.json({ feedback: rows });
  } catch (err) {
    console.error("League feedback GET error:", err);
    return NextResponse.json({ error: "Failed to fetch feedback" }, { status: 500 });
  }
}
