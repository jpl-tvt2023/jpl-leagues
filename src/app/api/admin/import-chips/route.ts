import { NextRequest, NextResponse } from "next/server";
import { db, teams, gameweeks, gameweekChips, groups } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { getChipSet } from "@/lib/chip-validation";
import { generateId } from "@/lib/id";

// Safely convert any value to a trimmed string
function toStr(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

interface ChipRow {
  teamName: string;
  [key: string]: string | number | undefined; // GW columns: "1", "2", etc. with "W", "D", or "C"
}

interface ImportResult {
  success: string[];
  errors: string[];
  warnings: string[];
}

/**
 * POST /api/admin/import-chips
 * Admin-only endpoint to bulk import TVT chip data
 * 
 * Excel format:
 * | Team        | 1 | 2 | 3 | ... | 29 | 30 |
 * | Team Name 1 | W |   | D |     |    | C  |
 * | Team Name 2 |   | C |   |     | W  |    |
 * 
 * W = Win-Win, D = Double Pointer, C = Challenge Chip
 */
export async function POST(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const { chips: chipRows } = body as { chips: ChipRow[] };

    if (!chipRows || !Array.isArray(chipRows) || chipRows.length === 0) {
      return NextResponse.json(
        { error: "No chip data provided" },
        { status: 400 }
      );
    }

    if (chipRows.length > 500) {
      return NextResponse.json(
        { error: "Too many rows. Maximum 500 chip entries per upload." },
        { status: 400 }
      );
    }

    const results: ImportResult = {
      success: [],
      errors: [],
      warnings: [],
    };

    // Get all teams — index by both full name and abbreviation for flexible matching
    const allTeams = await db.select().from(teams);
    const teamMap = new Map<string, typeof allTeams[0]>();
    for (const t of allTeams) {
      teamMap.set(t.name.toLowerCase(), t);
      if (t.abbreviation) teamMap.set(t.abbreviation.toLowerCase(), t);
    }

    // Get all gameweeks
    const allGameweeks = await db.select().from(gameweeks);
    const gameweekMap = new Map(allGameweeks.map(gw => [gw.number, gw]));

    // Process each chip row
    for (let i = 0; i < chipRows.length; i++) {
      const row = chipRows[i];
      const rowNum = i + 2; // Excel row number (header is row 1)

      try {
        const teamName = toStr(row.teamName || row["Team"] || row["team"] || row["Team Name"] || row["team name"]);

        if (!teamName) {
          results.errors.push(`Row ${rowNum}: Missing team name`);
          continue;
        }

        // Find team
        const team = teamMap.get(teamName.toLowerCase());
        if (!team) {
          results.errors.push(`Row ${rowNum}: Team "${teamName}" not found`);
          continue;
        }

        // Process each gameweek column
        for (let gw = 1; gw <= 38; gw++) {
          // Check various column name formats
          const gwValue = toStr(
            row[String(gw)] || 
            row[`GW${gw}`] || 
            row[`gw${gw}`] || 
            row[`Gameweek ${gw}`] ||
            ""
          ).toUpperCase();
          
          // Parse chip markers:
          // W = Win-Win
          // D = Double Pointer
          // C = Challenge Chip (plain, no opponent)
          // C:OPP = Challenge Chip with opponent abbreviation e.g. C:TAD
          // DW = Wasted Double Pointer
          // WW = Wasted Win-Win
          // CW = Wasted Challenge
          let chipEntries: { type: "W" | "D" | "C"; wasted: boolean; opponentName?: string }[] = [];
          
          // Check for wasted chips first (DW, CW)
          if (gwValue === "DW") {
            chipEntries.push({ type: "D", wasted: true });
            chipEntries.push({ type: "W", wasted: false });
          } else if (gwValue === "CW") {
            chipEntries.push({ type: "C", wasted: true });
          } else if (gwValue === "WW") {
            chipEntries.push({ type: "W", wasted: true });
          } else {
            // CC with opponent abbreviation: C:TAD
            const ccWithOpp = gwValue.match(/^C:(.+)$/);
            if (ccWithOpp) {
              chipEntries.push({ type: "C", wasted: false, opponentName: ccWithOpp[1].trim() });
            } else {
              if (gwValue.includes("W")) chipEntries.push({ type: "W", wasted: false });
              if (gwValue.includes("D")) chipEntries.push({ type: "D", wasted: false });
              if (gwValue.includes("C")) chipEntries.push({ type: "C", wasted: false });
            }
          }
          
          for (const chipEntry of chipEntries) {
            const chipType = chipEntry.type;
            const isWasted = chipEntry.wasted;
            const chipName = chipType === "W" ? "Win-Win" : chipType === "D" ? "Double Pointer" : "Challenge";

            // Resolve CC opponent team ID if provided (C:OPP format)
            let challengedTeamId: string | null = null;
            if (chipType === "C" && chipEntry.opponentName) {
              const oppTeam = teamMap.get(chipEntry.opponentName.toLowerCase());
              if (oppTeam) {
                challengedTeamId = oppTeam.id;
              } else {
                results.warnings.push(`Row ${rowNum}: GW${gw} - CC opponent "${chipEntry.opponentName}" not found, storing without opponent`);
              }
            }
            
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

            // Check if chip entry already exists for this team/gameweek
            const existing = await db.select().from(gameweekChips).where(
              and(
                eq(gameweekChips.teamId, team.id),
                eq(gameweekChips.gameweekId, gameweek.id)
              )
            );

            if (existing.length > 0) {
              // Force overwrite — delete existing entry regardless of type
              const existingChip = existing[0];
              if (existingChip.chipType !== chipType) {
                results.warnings.push(
                  `Row ${rowNum}: GW${gw} - ${teamName} replaced ${existingChip.chipType} chip with ${chipType}`
                );
              }
              await db.delete(gameweekChips).where(eq(gameweekChips.id, existingChip.id));
            }

            // Insert chip — skip validation, admin import is authoritative
            await db.insert(gameweekChips).values({
              id: generateId(),
              teamId: team.id,
              gameweekId: gameweek.id,
              chipType,
              challengedTeamId,
              isValid: !isWasted,
              validationErrors: isWasted ? "Chip marked as wasted" : null,
              isProcessed: isWasted,
              pointsAwarded: 0,
              hadNegativeHits: isWasted && chipType === "W",
            });

            if (isWasted) {
              results.warnings.push(`Row ${rowNum}: GW${gw} - ${teamName} ${chipName} chip marked as WASTED`);
            } else {
              results.success.push(`Row ${rowNum}: GW${gw} - ${teamName} ${chipName} chip imported`);
            }

            // Update team's chip usage flags
            const chipSet = getChipSet(gw);
            if (chipSet !== "playoffs") {
              const updateData: Record<string, boolean> = {};
              
              if (chipType === "W") {
                updateData[chipSet === 1 ? "winWinSet1Used" : "winWinSet2Used"] = true;
              } else if (chipType === "D") {
                updateData[chipSet === 1 ? "doublePointerSet1Used" : "doublePointerSet2Used"] = true;
              } else if (chipType === "C") {
                updateData[chipSet === 1 ? "challengeChipSet1Used" : "challengeChipSet2Used"] = true;
              }
              
              await db.update(teams)
                .set(updateData)
                .where(eq(teams.id, team.id));
            }
          } // end for chipEntries
        }
      } catch (rowError) {
        results.errors.push(
          `Row ${rowNum}: Error processing - ${rowError instanceof Error ? rowError.message : "Unknown error"}`
        );
      }
    }

    return NextResponse.json({
      success: true,
      message: `Imported ${results.success.length} chips, ${results.errors.length} errors`,
      created: results.success.length,
      failed: results.errors.length,
      warningsCount: results.warnings.length,
      details: results,
    });
  } catch (error) {
    console.error("Error importing chips:", error);
    return NextResponse.json(
      { error: "Failed to import chips" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/import-chips
 * Get chip usage statistics
 */
export async function GET(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    // Get all chips with relationships
    const allChips = await db.query.gameweekChips.findMany({
      with: {
        team: true,
        gameweek: true,
      },
    });

    // Group by gameweek
    const chipsByGW: Record<number, Array<{
      teamName: string;
      chipType: string;
      isValid: boolean;
      isProcessed: boolean;
      errors?: string[];
    }>> = {};

    for (const chip of allChips) {
      const gwNum = chip.gameweek?.number;
      if (gwNum === undefined) continue;

      if (!chipsByGW[gwNum]) {
        chipsByGW[gwNum] = [];
      }

      chipsByGW[gwNum].push({
        teamName: chip.team?.name || "Unknown",
        chipType: chip.chipType,
        isValid: chip.isValid,
        isProcessed: chip.isProcessed,
        errors: chip.validationErrors ? JSON.parse(chip.validationErrors) : undefined,
      });
    }

    // Count by chip type
    const stats = {
      total: allChips.length,
      byType: {
        W: allChips.filter(c => c.chipType === "W").length,
        D: allChips.filter(c => c.chipType === "D").length,
        C: allChips.filter(c => c.chipType === "C").length,
      },
      valid: allChips.filter(c => c.isValid).length,
      invalid: allChips.filter(c => !c.isValid).length,
      processed: allChips.filter(c => c.isProcessed).length,
      pending: allChips.filter(c => !c.isProcessed).length,
    };

    return NextResponse.json({
      stats,
      chipsByGameweek: chipsByGW,
    });
  } catch (error) {
    console.error("Error fetching chip stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch chip statistics" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/import-chips
 * Clear all chip data (for re-import)
 */
export async function DELETE(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const gameweek = searchParams.get("gameweek");

    if (gameweek) {
      // Delete chips for specific gameweek
      const gwNum = parseInt(gameweek);
      const gw = await db.select().from(gameweeks).where(eq(gameweeks.number, gwNum));
      
      if (gw[0]) {
        await db.delete(gameweekChips).where(eq(gameweekChips.gameweekId, gw[0].id));
        return NextResponse.json({ 
          success: true, 
          message: `Cleared chips for GW${gwNum}` 
        });
      }
    } else {
      // Delete all chips
      await db.delete(gameweekChips);
      
      // Reset team chip usage flags
      await db.update(teams).set({
        doublePointerSet1Used: false,
        challengeChipSet1Used: false,
        winWinSet1Used: false,
        doublePointerSet2Used: false,
        challengeChipSet2Used: false,
        winWinSet2Used: false,
      });
      
      return NextResponse.json({ 
        success: true, 
        message: "Cleared all chip data" 
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing chips:", error);
    return NextResponse.json(
      { error: "Failed to clear chips" },
      { status: 500 }
    );
  }
}
