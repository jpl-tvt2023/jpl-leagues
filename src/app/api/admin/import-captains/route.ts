import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, gameweeks, gameweekCaptains } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";

// Safely convert any value to a trimmed string
function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

interface CaptainRow {
  teamName: string;
  playerName: string;
  [key: string]: string | number | undefined; // GW columns: "1", "2", etc.
}

/**
 * POST /api/admin/import-captains
 * Admin-only endpoint to bulk import captain data
 */
export async function POST(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const { captains: captainRows } = body as { captains: CaptainRow[] };

    if (!captainRows || !Array.isArray(captainRows) || captainRows.length === 0) {
      return NextResponse.json(
        { error: "No captain data provided" },
        { status: 400 }
      );
    }

    if (captainRows.length > 500) {
      return NextResponse.json(
        { error: "Too many rows. Maximum 500 captain entries per upload." },
        { status: 400 }
      );
    }

    const results: { success: string[]; errors: string[] } = {
      success: [],
      errors: [],
    };

    // Get all teams with players
    const allTeams = await db.query.teams.findMany({
      with: { players: true },
    });
    const teamMap = new Map(allTeams.map(t => [t.name.toLowerCase(), t]));

    // Get all gameweeks
    const allGameweeks = await db.select().from(gameweeks);
    const gameweekMap = new Map(allGameweeks.map(gw => [gw.number, gw]));

    // Process each captain row
    for (let i = 0; i < captainRows.length; i++) {
      const row = captainRows[i];
      const rowNum = i + 2; // Excel row number

      try {
        const teamName = toStr(row.teamName || row["Team"] || row["team"]);
        const playerName = toStr(row.playerName || row["Players"] || row["Player"] || row["player"]);

        if (!teamName || !playerName) {
          results.errors.push(`Row ${rowNum}: Missing team name or player name`);
          continue;
        }

        // Find team
        const team = teamMap.get(teamName.toLowerCase());
        if (!team) {
          results.errors.push(`Row ${rowNum}: Team "${teamName}" not found`);
          continue;
        }

        // Find player in team
        const player = team.players.find(
          p => p.name.toLowerCase() === playerName.toLowerCase()
        );
        if (!player) {
          results.errors.push(`Row ${rowNum}: Player "${playerName}" not found in team "${teamName}"`);
          continue;
        }

        // Process each gameweek column
        for (let gw = 1; gw <= 38; gw++) {
          // Check various column name formats
          const gwValue = row[String(gw)] || row[`GW${gw}`] || row[`gw${gw}`] || row[`Gameweek ${gw}`];
          
          if (toStr(gwValue).toUpperCase() === "C") {
            // This player was captain for this gameweek
            
            // Ensure gameweek exists
            let gameweek = gameweekMap.get(gw);
            if (!gameweek) {
              // Create gameweek if it doesn't exist
              const gwId = generateId();
              const deadline = new Date();
              deadline.setDate(deadline.getDate() + (7 * gw));
              deadline.setHours(11, 0, 0, 0);
              
              await db.insert(gameweeks).values({
                id: gwId,
                number: gw,
                deadline,
                isPlayoffs: gw > 30,
              });
              
              gameweek = { id: gwId, number: gw, deadline, isPlayoffs: gw > 30, createdAt: new Date(), updatedAt: new Date() };
              gameweekMap.set(gw, gameweek);
            }

            // Check if captain entry already exists
            const existing = await db.select().from(gameweekCaptains).where(
              and(
                eq(gameweekCaptains.gameweekId, gameweek.id),
                eq(gameweekCaptains.playerId, player.id)
              )
            );

            if (existing.length === 0) {
              // Create captain entry
              await db.insert(gameweekCaptains).values({
                id: generateId(),
                gameweekId: gameweek.id,
                playerId: player.id,
                fplScore: 0, // Will be filled when processing scores
                transferHits: 0,
                doubledScore: 0,
                isValid: true,
                announcedAt: new Date(),
              });
              
              // Update player's captaincy chips used count
              await db.update(players)
                .set({ captaincyChipsUsed: player.captaincyChipsUsed + 1 })
                .where(eq(players.id, player.id));
            }
          }
        }

        results.success.push(`Row ${rowNum}: Processed captain data for ${playerName} (${teamName})`);
      } catch (error) {
        console.error(`Error processing row ${rowNum}:`, error);
        results.errors.push(`Row ${rowNum}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    return NextResponse.json({
      message: `Processed ${captainRows.length} rows`,
      created: results.success.length,
      failed: results.errors.length,
      details: results,
    });
  } catch (error) {
    console.error("Import captains error:", error);
    return NextResponse.json(
      { error: "Failed to import captain data" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/import-captains
 * Get captain import status
 */
export async function GET(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    // Get count of captain entries per gameweek
    const allCaptains = await db.query.gameweekCaptains.findMany({
      with: {
        player: {
          with: { team: true },
        },
      },
    });

    const allGameweeks = await db.select().from(gameweeks);

    const gwStats = allGameweeks.map(gw => {
      const captainsForGW = allCaptains.filter(c => c.gameweekId === gw.id);
      return {
        gameweek: gw.number,
        captainCount: captainsForGW.length,
      };
    }).sort((a, b) => a.gameweek - b.gameweek);

    return NextResponse.json({
      totalCaptainEntries: allCaptains.length,
      gameweekStats: gwStats,
    });
  } catch (error) {
    console.error("Get captain stats error:", error);
    return NextResponse.json(
      { error: "Failed to get captain stats" },
      { status: 500 }
    );
  }
}
