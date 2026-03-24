import { NextRequest, NextResponse } from "next/server";
import { db, teams, auditLogs, gameweekChips, gameweeks } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";

// Valid chip types
const VALID_CHIPS = [
  "doublePointerSet1",
  "challengeChipSet1", 
  "winWinSet1",
  "doublePointerSet2",
  "challengeChipSet2",
  "winWinSet2",
] as const;

type ChipType = typeof VALID_CHIPS[number];

// Map chip type to database column
const chipToColumn: Record<ChipType, keyof typeof teams.$inferSelect> = {
  doublePointerSet1: "doublePointerSet1Used",
  challengeChipSet1: "challengeChipSet1Used",
  winWinSet1: "winWinSet1Used",
  doublePointerSet2: "doublePointerSet2Used",
  challengeChipSet2: "challengeChipSet2Used",
  winWinSet2: "winWinSet2Used",
};

// Chip display names for UI
const chipDisplayNames: Record<ChipType, string> = {
  doublePointerSet1: "Double Pointer (Set 1, GW1-15)",
  challengeChipSet1: "Challenge Chip (Set 1, GW1-15)",
  winWinSet1: "Win-Win (Set 1, GW1-15)",
  doublePointerSet2: "Double Pointer (Set 2, GW16-30)",
  challengeChipSet2: "Challenge Chip (Set 2, GW16-30)",
  winWinSet2: "Win-Win (Set 2, GW16-30)",
};

/**
 * POST /api/admin/override-chips
 * Admin-only endpoint to override chip usage for a team
 */
export async function POST(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const { teamId, chipType, status, reason, used, gameweek } = body;

    // Support both old "used" boolean and new "status" field for backwards compatibility
    let chipStatus: "available" | "used" | "wasted";
    if (status !== undefined) {
      chipStatus = status;
    } else if (used !== undefined) {
      chipStatus = used ? "used" : "available";
    } else {
      return NextResponse.json(
        { error: "teamId, chipType, and status are required" },
        { status: 400 }
      );
    }

    // Validate required fields
    if (!teamId || !chipType) {
      return NextResponse.json(
        { error: "teamId, chipType, and status are required" },
        { status: 400 }
      );
    }

    // Validate gameweek is provided for used/wasted status
    if (chipStatus !== "available" && !gameweek) {
      return NextResponse.json(
        { error: "Gameweek is required when setting status to used or wasted" },
        { status: 400 }
      );
    }

    // Validate gameweek is in valid range for the chip set
    if (chipStatus !== "available" && gameweek) {
      const gwNum = parseInt(gameweek);
      const isSet1 = chipType.includes("Set1");
      if (isSet1 && (gwNum < 1 || gwNum > 15)) {
        return NextResponse.json(
          { error: "Set 1 chips must be used in GW1-15" },
          { status: 400 }
        );
      }
      if (!isSet1 && (gwNum < 16 || gwNum > 30)) {
        return NextResponse.json(
          { error: "Set 2 chips must be used in GW16-30" },
          { status: 400 }
        );
      }
    }

    // Validate status
    if (!["available", "used", "wasted"].includes(chipStatus)) {
      return NextResponse.json(
        { error: "Invalid status. Valid values: available, used, wasted" },
        { status: 400 }
      );
    }

    // Validate chip type
    if (!VALID_CHIPS.includes(chipType)) {
      return NextResponse.json(
        { error: `Invalid chip type. Valid types: ${VALID_CHIPS.join(", ")}` },
        { status: 400 }
      );
    }

    // Get the team
    const teamList = await db.select().from(teams).where(eq(teams.id, teamId));
    const team = teamList[0];

    if (!team) {
      return NextResponse.json(
        { error: "Team not found" },
        { status: 404 }
      );
    }

    // Get current state
    const column = chipToColumn[chipType as ChipType];
    const wasUsed = team[column as keyof typeof team];

    // For "used" and "wasted", the chip counts as used in the teams table
    // For "available", reset to false
    const isUsed = chipStatus !== "available";

    // Update chip state in teams table
    const updateData: Partial<typeof teams.$inferInsert> = {
      [column]: isUsed,
      updatedAt: new Date(),
    };

    await db.update(teams)
      .set(updateData)
      .where(eq(teams.id, teamId));

    // Extract set number and chip type code from chipType
    const setMatch = chipType.match(/Set(\d)$/);
    const setNumber = setMatch ? parseInt(setMatch[1]) : 1;
    const chipCode = chipType.startsWith("doublePointer") ? "D" 
      : chipType.startsWith("challengeChip") ? "C" 
      : "W";
    
    // Find existing chip record for this team and chip type in this set
    const existingChips = await db.select()
      .from(gameweekChips)
      .innerJoin(gameweeks, eq(gameweekChips.gameweekId, gameweeks.id))
      .where(
        and(
          eq(gameweekChips.teamId, teamId),
          eq(gameweekChips.chipType, chipCode)
        )
      );
    
    // Find chips in the target set (GW1-15 for set1, GW16-30 for set2)
    const chipsInSet = existingChips.filter(c => {
      const gwNum = c.gameweeks.number;
      return setNumber === 1 ? gwNum <= 15 : gwNum > 15 && gwNum <= 30;
    });

    // Delete any existing chip records for this chip type/set
    for (const chip of chipsInSet) {
      await db.delete(gameweekChips)
        .where(eq(gameweekChips.id, chip.gameweek_chips.id));
    }

    // If marking as used or wasted, create a new gameweekChips record
    if (chipStatus !== "available" && gameweek) {
      const gwNum = parseInt(gameweek);
      
      // Find or create the gameweek record
      let gwRecord = await db.select().from(gameweeks).where(eq(gameweeks.number, gwNum));
      let gameweekId: string;
      
      if (gwRecord.length === 0) {
        // Create the gameweek record
        gameweekId = generateId();
        const deadline = new Date();
        deadline.setDate(deadline.getDate() + (7 * gwNum));
        deadline.setHours(11, 0, 0, 0);
        await db.insert(gameweeks).values({
          id: gameweekId,
          number: gwNum,
          deadline,
          isPlayoffs: gwNum > 30,
        });
      } else {
        gameweekId = gwRecord[0].id;
      }
      
      // Create the chip record
      await db.insert(gameweekChips).values({
        id: generateId(),
        teamId: teamId,
        gameweekId: gameweekId,
        chipType: chipCode,
        isValid: chipStatus === "used", // false for wasted
        isProcessed: true,
        hadNegativeHits: chipStatus === "wasted", // flag for wasted chips
        pointsAwarded: 0,
      });
    }

    // Determine status display text
    const statusText = chipStatus === "wasted" 
      ? `wasted in GW${gameweek}` 
      : chipStatus === "used" 
        ? `used in GW${gameweek}` 
        : "available";
    const previousStatusText = wasUsed ? "used" : "available";

    // Log the override
    await db.insert(auditLogs).values({
      id: generateId(),
      type: "ADMIN_OVERRIDE",
      description: `Admin override: ${chipDisplayNames[chipType as ChipType]} changed from ${previousStatusText} to ${statusText} for ${team.name}. Reason: ${reason || "Not specified"}`,
      teamId: teamId,
      pointsAffected: 0,
    });

    return NextResponse.json({
      success: true,
      message: `${chipDisplayNames[chipType as ChipType]} status updated to ${statusText}`,
      override: {
        teamName: team.name,
        chipType: chipType,
        chipDisplayName: chipDisplayNames[chipType as ChipType],
        previousState: previousStatusText,
        newState: statusText,
      },
    });
  } catch (error) {
    console.error("Admin chips override error:", error);
    return NextResponse.json(
      { error: "Failed to override chip status" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/override-chips
 * Get all teams and their chip status for admin override
 */
export async function GET(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    // Get all teams with chip status
    const allTeams = await db.query.teams.findMany({
      with: {
        group: true,
      },
    });

    // Get all chip usage from gameweekChips table to get GW numbers and wasted status
    const allChipUsage = await db.query.gameweekChips.findMany({
      with: {
        gameweek: true,
      },
    });

    // Create a lookup map: teamId -> chipType -> { gwNumber, wasted, points }
    const chipGwLookup = new Map<string, Map<string, { gwNumber: number; wasted: boolean; points: number }>>();
    for (const chip of allChipUsage) {
      if (!chipGwLookup.has(chip.teamId)) {
        chipGwLookup.set(chip.teamId, new Map());
      }
      const gwNumber = chip.gameweek.number;
      const set = gwNumber <= 15 ? 1 : 2;
      const key = `${chip.chipType}${set}`; // e.g., "W1", "D2", "C1"
      // Chip is wasted if it's processed but invalid, or has hadNegativeHits flag
      const wasted = (chip.isProcessed && !chip.isValid) || chip.hadNegativeHits;
      chipGwLookup.get(chip.teamId)!.set(key, { gwNumber, wasted, points: chip.pointsAwarded || 0 });
    }

    return NextResponse.json({
      teams: allTeams.map(t => {
        const teamChips = chipGwLookup.get(t.id) || new Map();
        return {
          id: t.id,
          name: t.name,
          group: t.group.name,
          chips: {
            set1: {
              doublePointer: {
                used: t.doublePointerSet1Used,
                name: "Double Pointer (GW1-15)",
                gameweek: teamChips.get("D1")?.gwNumber || null,
                wasted: teamChips.get("D1")?.wasted || false,
                points: teamChips.get("D1")?.points || 0,
              },
              challengeChip: {
                used: t.challengeChipSet1Used,
                name: "Challenge Chip (GW1-15)",
                gameweek: teamChips.get("C1")?.gwNumber || null,
                wasted: teamChips.get("C1")?.wasted || false,
                points: teamChips.get("C1")?.points || 0,
              },
              winWin: {
                used: t.winWinSet1Used,
                name: "Win-Win (GW1-15)",
                gameweek: teamChips.get("W1")?.gwNumber || null,
                wasted: teamChips.get("W1")?.wasted || false,
                points: teamChips.get("W1")?.points || 0,
              },
            },
            set2: {
              doublePointer: {
                used: t.doublePointerSet2Used,
                name: "Double Pointer (GW16-30)",
                gameweek: teamChips.get("D2")?.gwNumber || null,
                wasted: teamChips.get("D2")?.wasted || false,
                points: teamChips.get("D2")?.points || 0,
              },
              challengeChip: {
                used: t.challengeChipSet2Used,
                name: "Challenge Chip (GW16-30)",
                gameweek: teamChips.get("C2")?.gwNumber || null,
                wasted: teamChips.get("C2")?.wasted || false,
                points: teamChips.get("C2")?.points || 0,
              },
              winWin: {
                used: t.winWinSet2Used,
                name: "Win-Win (GW16-30)",
                gameweek: teamChips.get("W2")?.gwNumber || null,
                wasted: teamChips.get("W2")?.wasted || false,
                points: teamChips.get("W2")?.points || 0,
              },
            },
          },
        };
      }),
      chipTypes: VALID_CHIPS.map(c => ({
        value: c,
        label: chipDisplayNames[c],
      })),
    });
  } catch (error) {
    console.error("Failed to fetch chip data:", error);
    return NextResponse.json(
      { error: "Failed to fetch data" },
      { status: 500 }
    );
  }
}
