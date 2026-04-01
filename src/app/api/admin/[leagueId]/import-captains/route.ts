import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, gameweeks, gameweekCaptains, leagues } from "@/lib/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

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
 * POST /api/admin/[leagueId]/import-captains
 * Admin-only endpoint to bulk import captain data
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

    // Fetch league config
    const leagueRecord = await db
      .select({ playoffStartGw: leagues.playoffStartGw })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    if (!leagueRecord.length) return NextResponse.json({ error: "League not found" }, { status: 404 });
    const { playoffStartGw } = leagueRecord[0];

    // Get all teams with players for this league
    const allTeams = await db.query.teams.findMany({
      where: eq(teams.leagueId, leagueId),
      with: { players: true },
    });
    const teamMap = new Map(allTeams.map(t => [t.name.toLowerCase(), t]));

    // Get all gameweeks for this league
    const allGameweeks = await db.select().from(gameweeks).where(eq(gameweeks.leagueId, leagueId));
    const gameweekMap = new Map(allGameweeks.map(gw => [gw.number, gw]));

    // Pre-load ALL existing captain records for this league's gameweeks in one query.
    // Key: `${gameweekId}|${playerId}` → record id
    const existingCaptainsMap = new Map<string, { id: string; gameweekId: string; playerId: string }>();
    const allGwIds = allGameweeks.map(gw => gw.id);
    if (allGwIds.length > 0) {
      const allExisting = await db
        .select({ id: gameweekCaptains.id, gameweekId: gameweekCaptains.gameweekId, playerId: gameweekCaptains.playerId })
        .from(gameweekCaptains)
        .where(inArray(gameweekCaptains.gameweekId, allGwIds));
      for (const c of allExisting) {
        existingCaptainsMap.set(`${c.gameweekId}|${c.playerId}`, c);
      }
    }

    // Collect records to insert and update in memory, then execute in bulk
    const toInsert: Array<{
      id: string;
      gameweekId: string;
      playerId: string;
      fplScore: number;
      transferHits: number;
      doubledScore: number;
      isValid: boolean;
      announcedAt: Date;
    }> = [];
    const toUpdate: Array<{ id: string; newPlayerId: string }> = [];
    // Track chips increments: playerId → count of new captain entries
    const chipsIncrement = new Map<string, number>();

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
          const gwValue = row[String(gw)] || row[`GW${gw}`] || row[`gw${gw}`] || row[`Gameweek ${gw}`];

          if (toStr(gwValue).toUpperCase() !== "C") continue;

          // Ensure gameweek exists for this league
          let gameweek = gameweekMap.get(gw);
          if (!gameweek) {
            const gwId = generateId();
            const deadline = new Date();
            deadline.setDate(deadline.getDate() + (7 * gw));
            deadline.setHours(11, 0, 0, 0);

            await db.insert(gameweeks).values({
              id: gwId,
              number: gw,
              deadline,
              isPlayoffs: gw >= playoffStartGw,
              leagueId,
            });

            gameweek = { id: gwId, number: gw, deadline, isPlayoffs: gw >= playoffStartGw, leagueId, createdAt: new Date(), updatedAt: new Date() };
            gameweekMap.set(gw, gameweek);
          }

          // Check in-memory map: any existing captain for this team in this GW?
          const teamPlayerIds = team.players.map(p => p.id);
          const existingEntry = teamPlayerIds
            .map(pid => existingCaptainsMap.get(`${gameweek!.id}|${pid}`))
            .find(Boolean);

          if (existingEntry) {
            if (existingEntry.playerId !== player.id) {
              // Need to update to point to the new player
              toUpdate.push({ id: existingEntry.id, newPlayerId: player.id });
              // Update in-memory map: remove old key, add new key
              existingCaptainsMap.delete(`${gameweek.id}|${existingEntry.playerId}`);
              existingCaptainsMap.set(`${gameweek.id}|${player.id}`, { ...existingEntry, playerId: player.id });
            }
            // else: same player, no change needed
          } else {
            // New entry
            const newId = generateId();
            toInsert.push({
              id: newId,
              gameweekId: gameweek.id,
              playerId: player.id,
              fplScore: 0,
              transferHits: 0,
              doubledScore: 0,
              isValid: true,
              announcedAt: new Date(),
            });
            // Register in map so duplicate rows in same upload don't double-insert
            existingCaptainsMap.set(`${gameweek.id}|${player.id}`, { id: newId, gameweekId: gameweek.id, playerId: player.id });
            // Track chips increment
            chipsIncrement.set(player.id, (chipsIncrement.get(player.id) ?? 0) + 1);
          }
        }

        results.success.push(`Row ${rowNum}: Processed captain data for ${playerName} (${teamName})`);
      } catch (error) {
        console.error(`Error processing row ${rowNum}:`, error);
        results.errors.push(`Row ${rowNum}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    // Execute bulk insert (one query for all new records)
    if (toInsert.length > 0) {
      await db.insert(gameweekCaptains).values(toInsert);
    }

    // Execute updates (only for records where the player actually changed)
    for (const upd of toUpdate) {
      await db.update(gameweekCaptains)
        .set({ playerId: upd.newPlayerId, isValid: true, updatedAt: new Date() })
        .where(eq(gameweekCaptains.id, upd.id));
    }

    // Increment captaincy chips used (one query per unique player with new entries)
    for (const [playerId, increment] of chipsIncrement) {
      await db.update(players)
        .set({ captaincyChipsUsed: sql`${players.captaincyChipsUsed} + ${increment}` })
        .where(eq(players.id, playerId));
    }

    await invalidateLeaguePageCache(leagueId);
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
 * GET /api/admin/[leagueId]/import-captains
 * Get captain import status
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Get count of captain entries per gameweek — scoped to this league
    const allGameweeks = await db.select({ id: gameweeks.id, number: gameweeks.number })
      .from(gameweeks).where(eq(gameweeks.leagueId, leagueId));
    const gwIds = allGameweeks.map(gw => gw.id);
    const allCaptains = gwIds.length > 0
      ? await db.query.gameweekCaptains.findMany({
          where: inArray(gameweekCaptains.gameweekId, gwIds),
          with: { player: { with: { team: true } } },
        })
      : [];

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
