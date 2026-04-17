import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * POST /api/admin/[leagueId]/create-gameweeks
 * Creates GW 1–38 for an auction league using real FPL event deadlines.
 * Skips any gameweeks that already exist.
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Fetch real FPL gameweek deadlines from bootstrap
    const fplRes = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", {
      cache: "no-store",
    });
    if (!fplRes.ok) {
      return NextResponse.json({ error: "Failed to fetch FPL gameweek data" }, { status: 502 });
    }
    const fplData = await fplRes.json();
    const events: { id: number; deadline_time: string; is_playoffs?: boolean }[] = fplData.events ?? [];

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
      if (event.id < 1 || event.id > 38) continue;

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

    return NextResponse.json({ success: true, created, skipped });
  } catch (err) {
    console.error("[create-gameweeks]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
