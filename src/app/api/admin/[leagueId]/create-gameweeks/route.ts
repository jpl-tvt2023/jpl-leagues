import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { fetchBootstrapData } from "@/lib/fpl";

/**
 * POST /api/admin/[leagueId]/create-gameweeks
 * Creates the league's gameweeks using real FPL event deadlines, from the league's
 * configured `startGameweek` (default 1) through GW38.
 *
 * Not seeding rows below the start gameweek is what makes a mid-season league work:
 * the cron plan builds its due list from existing gameweek rows, and the auction
 * processor no-ops when a row is absent, so earlier gameweeks are skipped for free.
 *
 * Skips any gameweeks that already exist.
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const leagueRow = await db
      .select({ startGameweek: leagues.startGameweek })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    const startGw = leagueRow[0]?.startGameweek ?? 1;

    // Fetch real FPL gameweek deadlines from bootstrap
    let fplData: { events?: { id: number; deadline_time: string; is_playoffs?: boolean }[] };
    try {
      fplData = await fetchBootstrapData();
    } catch {
      return NextResponse.json({ error: "Failed to fetch FPL gameweek data" }, { status: 502 });
    }
    const events = fplData.events ?? [];

    if (events.length === 0) {
      return NextResponse.json({ error: "No FPL events found" }, { status: 502 });
    }

    // Fetch existing gameweeks for this league
    const existing = await db
      .select({ number: gameweeks.number })
      .from(gameweeks)
      .where(eq(gameweeks.leagueId, leagueId));
    const existingNumbers = new Set(existing.map((g) => g.number));

    let created = 0;
    let skipped = 0;

    for (const event of events) {
      if (event.id < startGw || event.id > 38) continue;

      if (existingNumbers.has(event.id)) {
        skipped++;
        continue;
      }

      const deadline = new Date(event.deadline_time);
      await db.insert(gameweeks).values({
        id: generateId(),
        number: event.id,
        leagueId,
        deadline,
        isPlayoffs: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      created++;
    }

    return NextResponse.json({ success: true, created, skipped, startGameweek: startGw });
  } catch (err) {
    console.error("[create-gameweeks]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
