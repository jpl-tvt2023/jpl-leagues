import { NextRequest, NextResponse } from "next/server";
import { db, teams, groups, gameweeks, fixtures } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";

interface FixtureRow {
  gameweek: string | number;
  homeTeam: string;
  awayTeam: string;
}

/**
 * POST /api/admin/bulk-upload-fixtures
 * Admin-only endpoint to bulk upload fixtures from CSV data
 */
export async function POST(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const { fixtures: fixtureRows, clearExisting } = body as { 
      fixtures: FixtureRow[]; 
      clearExisting?: boolean;
    };

    if (!fixtureRows || !Array.isArray(fixtureRows) || fixtureRows.length === 0) {
      return NextResponse.json(
        { error: "No fixtures data provided" },
        { status: 400 }
      );
    }

    if (fixtureRows.length > 500) {
      return NextResponse.json(
        { error: "Too many rows. Maximum 500 fixtures per upload." },
        { status: 400 }
      );
    }

    const results: { success: string[]; errors: string[] } = {
      success: [],
      errors: [],
    };

    // Get all teams for lookup
    const allTeams = await db.query.teams.findMany({
      with: { group: true },
    });
    const teamMap = new Map(allTeams.map(t => [t.name.toLowerCase(), t]));

    // Get all gameweeks for lookup
    const allGameweeks = await db.select().from(gameweeks);
    const gameweekMap = new Map(allGameweeks.map(gw => [gw.number, gw]));

    // Optionally clear existing fixtures (for re-upload)
    if (clearExisting) {
      await db.delete(fixtures);
    }

    // Process each fixture row
    for (let i = 0; i < fixtureRows.length; i++) {
      const row = fixtureRows[i];
      const rowNum = i + 2; // Excel row number (1-indexed + header)

      try {
        // Validate required fields
        if (!row.gameweek || !row.homeTeam || !row.awayTeam) {
          results.errors.push(`Row ${rowNum}: Missing required fields (gameweek, homeTeam, awayTeam)`);
          continue;
        }

        const gwNumber = typeof row.gameweek === 'string' ? parseInt(row.gameweek) : row.gameweek;
        if (isNaN(gwNumber) || gwNumber < 1 || gwNumber > 38) {
          results.errors.push(`Row ${rowNum}: Invalid gameweek number (must be 1-38)`);
          continue;
        }

        // Find home team
        const homeTeam = teamMap.get(row.homeTeam.toLowerCase().trim());
        if (!homeTeam) {
          results.errors.push(`Row ${rowNum}: Home team "${row.homeTeam}" not found`);
          continue;
        }

        // Find away team
        const awayTeam = teamMap.get(row.awayTeam.toLowerCase().trim());
        if (!awayTeam) {
          results.errors.push(`Row ${rowNum}: Away team "${row.awayTeam}" not found`);
          continue;
        }

        // Verify teams are in the same group
        if (homeTeam.groupId !== awayTeam.groupId) {
          results.errors.push(`Row ${rowNum}: Teams must be in the same group`);
          continue;
        }

        // Default deadline: Saturday 11:00 UTC based on gameweek
        const deadline = new Date();
        deadline.setDate(deadline.getDate() + (7 * gwNumber));
        deadline.setHours(11, 0, 0, 0);

        // Get or create gameweek
        let gw = gameweekMap.get(gwNumber);
        if (!gw) {
          const gwId = generateId();
          await db.insert(gameweeks).values({
            id: gwId,
            number: gwNumber,
            deadline: deadline,
            isPlayoffs: gwNumber > 30,
          });
          gw = { id: gwId, number: gwNumber, deadline, isPlayoffs: gwNumber > 30, createdAt: new Date(), updatedAt: new Date() };
          gameweekMap.set(gwNumber, gw);
        }

        // Check if fixture already exists
        const existingFixtures = await db.select().from(fixtures).where(
          and(
            eq(fixtures.gameweekId, gw.id),
            eq(fixtures.homeTeamId, homeTeam.id),
            eq(fixtures.awayTeamId, awayTeam.id)
          )
        );

        if (existingFixtures.length > 0) {
          results.errors.push(`Row ${rowNum}: Fixture already exists (GW${gwNumber}: ${row.homeTeam} vs ${row.awayTeam})`);
          continue;
        }

        // Create fixture
        await db.insert(fixtures).values({
          id: generateId(),
          gameweekId: gw.id,
          homeTeamId: homeTeam.id,
          awayTeamId: awayTeam.id,
          groupId: homeTeam.groupId,
        });

        results.success.push(`Row ${rowNum}: GW${gwNumber} - ${row.homeTeam} vs ${row.awayTeam} created`);
      } catch (error) {
        console.error(`Error processing row ${rowNum}:`, error);
        results.errors.push(`Row ${rowNum}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    return NextResponse.json({
      message: `Processed ${fixtureRows.length} rows`,
      created: results.success.length,
      failed: results.errors.length,
      details: results,
    });
  } catch (error) {
    console.error("Bulk upload fixtures error:", error);
    return NextResponse.json(
      { error: "Failed to process bulk upload" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/bulk-upload-fixtures
 * Get template structure for fixture upload
 */
export async function GET(request: NextRequest) {
  const sessionType = request.headers.get("x-session-type");
  if (sessionType !== "admin" && sessionType !== "superadmin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  // Get existing teams for reference
  const allTeams = await db.query.teams.findMany({
    with: { group: true },
  });

  return NextResponse.json({
    template: {
      columns: ["Gameweek", "Home Team", "Away Team", "Deadline"],
      example: ["1", "DM — Rahul", "SK — Arjun", "2026-03-15 11:00"],
    },
    csvHeader: "Gameweek,Home Team,Away Team,Deadline",
    csvExample: "1,DM — Rahul,SK — Arjun,2026-03-15 11:00",
    existingTeams: allTeams.map(t => ({
      name: t.name,
      group: t.group.name,
    })),
  });
}
