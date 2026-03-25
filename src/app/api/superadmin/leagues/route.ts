import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues, teams, gameweeks } from "@/lib/db/schema";
import { eq, and, max, count } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";

export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }
  const all = await db.select().from(leagues).orderBy(leagues.createdAt);

  // Attach quick stats to each league
  const leaguesWithStats = await Promise.all(
    all.map(async (league) => {
      const [teamCountRow] = await db
        .select({ count: count() })
        .from(teams)
        .where(eq(teams.leagueId, league.id));

      const [currentGwRow] = await db
        .select({ maxGw: max(gameweeks.number) })
        .from(gameweeks)
        .where(and(eq(gameweeks.leagueId, league.id)));

      return {
        ...league,
        teamCount: teamCountRow?.count ?? 0,
        currentGameweek: currentGwRow?.maxGw ?? null,
      };
    })
  );

  return NextResponse.json({ leagues: leaguesWithStats });
}

export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { slug, name, sport, format, season } = body;

  if (!slug || !name || !sport || !format || !season) {
    return NextResponse.json({ error: "slug, name, sport, format, and season are required" }, { status: 400 });
  }

  try {
    const id = generateId();
    await db.insert(leagues).values({ id, slug, name, sport, format, season, isActive: true });
    return NextResponse.json({
      success: true,
      id,
      slug,
      name,
      sport,
      format,
      season,
      isActive: true,
      teamCount: 0,
      currentGameweek: null,
    });
  } catch {
    return NextResponse.json({ error: "League with that slug already exists" }, { status: 409 });
  }
}
