import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/leagues
 * Returns all active leagues (public endpoint)
 */
export async function GET() {
  try {
    const allLeagues = await db
      .select({
        id: leagues.id,
        slug: leagues.slug,
        name: leagues.name,
        sport: leagues.sport,
        format: leagues.format,
        season: leagues.season,
        teamSize: leagues.teamSize,
        isActive: leagues.isActive,
      })
      .from(leagues)
      .where(eq(leagues.isActive, true));

    return NextResponse.json({ leagues: allLeagues });
  } catch (error) {
    console.error("Error fetching leagues:", error);
    return NextResponse.json({ error: "Failed to fetch leagues" }, { status: 500 });
  }
}
