import { NextRequest, NextResponse } from "next/server";
import { db, teams, gameweeks, gameweekChips, settings, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { generateId } from "@/lib/id";

const ALL_CHIP_CODES = ["W", "D", "C", "SL", "CB", "UD"] as const;
type ChipCode = typeof ALL_CHIP_CODES[number];

const CHIP_NAMES: Record<ChipCode, string> = {
  W: "Win-Win", D: "Double Pointer", C: "Challenge Chip",
  SL: "Score Lock", CB: "Comeback", UD: "Underdog",
};

// Column name for the set-used flag on the teams table
const CHIP_SET_COL: Record<ChipCode, [keyof typeof teams.$inferSelect, keyof typeof teams.$inferSelect]> = {
  W:  ["winWinSet1Used",        "winWinSet2Used"],
  D:  ["doublePointerSet1Used", "doublePointerSet2Used"],
  C:  ["challengeChipSet1Used", "challengeChipSet2Used"],
  SL: ["scoreLockSet1Used",     "scoreLockSet2Used"],
  CB: ["comebackSet1Used",      "comebackSet2Used"],
  UD: ["underdogSet1Used",      "underdogSet2Used"],
};

function getChipSet(gwNumber: number, playoffStartGw: number): 1 | 2 | "playoffs" {
  if (gwNumber >= playoffStartGw) return "playoffs";
  const midpoint = Math.ceil((playoffStartGw - 1) / 2);
  return gwNumber <= midpoint ? 1 : 2;
}

/**
 * POST /api/team/chips
 * Submit a TVT chip for a gameweek
 */
export async function POST(request: NextRequest) {
  try {
    // Check if team is logged in
    const teamId = request.headers.get("x-session-id");
    if (!teamId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const { gameweek, chipType, challengedTeamId } = body;

    // Validate required fields
    if (!gameweek || !chipType) {
      return NextResponse.json(
        { error: "gameweek and chipType are required" },
        { status: 400 }
      );
    }

    const gameweekNumber = parseInt(gameweek);
    if (isNaN(gameweekNumber) || gameweekNumber < 1 || gameweekNumber > 38) {
      return NextResponse.json(
        { error: "Invalid gameweek number (must be 1-38)" },
        { status: 400 }
      );
    }

    // Validate chip type is one of the 6 known codes
    if (!ALL_CHIP_CODES.includes(chipType as ChipCode)) {
      return NextResponse.json(
        { error: "Invalid chipType. Must be one of: W, D, C, SL, CB, UD" },
        { status: 400 }
      );
    }

    // Get team with league
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      with: { group: true },
    });

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    // Get league config (enabledChips + playoffStartGw)
    const leagueRow = await db.select({ enabledChips: leagues.enabledChips, playoffStartGw: leagues.playoffStartGw })
      .from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }
    let enabledChips: string[] = ["D", "W", "C"];
    try { enabledChips = JSON.parse(leagueRow[0].enabledChips ?? '["D","W","C"]'); } catch { /* keep default */ }
    const playoffStartGw = leagueRow[0].playoffStartGw ?? 31;

    // Check chip is enabled for this league
    if (!enabledChips.includes(chipType)) {
      return NextResponse.json(
        { error: `${CHIP_NAMES[chipType as ChipCode]} is not enabled for this league` },
        { status: 400 }
      );
    }

    // Get gameweek (must be in this team's league)
    const gw = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, gameweekNumber), eq(gameweeks.leagueId, team.leagueId)),
    });

    if (!gw) {
      return NextResponse.json({ error: "Gameweek not found" }, { status: 404 });
    }

    // Check if chip announcements are enabled
    const chipSetting = await db.select().from(settings).where(eq(settings.key, "chipAnnouncementEnabled")).limit(1);
    if (chipSetting.length > 0 && chipSetting[0].value === "false") {
      return NextResponse.json(
        { error: "Chip announcements are currently disabled by the admin" },
        { status: 403 }
      );
    }

    // Check deadline
    const now = new Date();
    if (gw.deadline && gw.deadline < now) {
      return NextResponse.json(
        { error: "Deadline has passed for this gameweek" },
        { status: 400 }
      );
    }

    // Check chip set (dynamic boundaries from league config)
    const chipSet = getChipSet(gameweekNumber, playoffStartGw);
    if (chipSet === "playoffs") {
      return NextResponse.json(
        { error: `TVT chips cannot be used in playoffs (GW${playoffStartGw}+)` },
        { status: 400 }
      );
    }

    const chipName = CHIP_NAMES[chipType as ChipCode];
    const midpoint = Math.ceil((playoffStartGw - 1) / 2);
    const set1Range = `GW1-${midpoint}`;
    const set2Range = `GW${midpoint + 1}-${playoffStartGw - 1}`;
    const setRange = chipSet === 1 ? set1Range : set2Range;

    // Check if chip is already used for this set using the column map
    const [col1, col2] = CHIP_SET_COL[chipType as ChipCode];
    const alreadyUsed = chipSet === 1
      ? !!team[col1 as keyof typeof team]
      : !!team[col2 as keyof typeof team];

    if (alreadyUsed) {
      return NextResponse.json(
        { error: `${chipName} has already been used for Set ${chipSet} (${setRange})` },
        { status: 400 }
      );
    }

    // Check if team has already submitted a chip for this gameweek
    const existingChip = await db.query.gameweekChips.findFirst({
      where: and(
        eq(gameweekChips.teamId, teamId),
        eq(gameweekChips.gameweekId, gw.id)
      ),
    });

    // If switching to same chip type, no-op
    if (existingChip && existingChip.chipType === chipType) {
      return NextResponse.json(
        { error: `${chipName} is already selected for this gameweek` },
        { status: 400 }
      );
    }

    // If switching chip types, check the NEW type isn't already used in the set
    // (the old type doesn't count since we're replacing it)
    if (existingChip && existingChip.chipType !== chipType) {
      const [newCol1, newCol2] = CHIP_SET_COL[chipType as ChipCode];
      const newAlreadyUsed = chipSet === 1
        ? !!team[newCol1 as keyof typeof team]
        : !!team[newCol2 as keyof typeof team];
      if (newAlreadyUsed) {
        return NextResponse.json(
          { error: `${chipName} has already been used for Set ${chipSet} (${setRange})` },
          { status: 400 }
        );
      }
    }

    // For Challenge Chip, validate the challenged team
    let validatedChallengedTeamId = null;
    if (chipType === "C") {
      if (!challengedTeamId) {
        return NextResponse.json(
          { error: "Challenge Chip requires selecting an opponent team" },
          { status: 400 }
        );
      }

      // Verify the challenged team is in the opposite group
      const challengedTeam = await db.query.teams.findFirst({
        where: eq(teams.id, challengedTeamId),
        with: { group: true },
      });

      if (!challengedTeam) {
        return NextResponse.json(
          { error: "Challenged team not found" },
          { status: 404 }
        );
      }

      if (challengedTeam.groupId === team.groupId) {
        return NextResponse.json(
          { error: "Challenge Chip can only be used against a team from the opposite group" },
          { status: 400 }
        );
      }

      validatedChallengedTeamId = challengedTeamId;
    }

    if (existingChip) {
      // Switch: update existing chip record
      await db.update(gameweekChips)
        .set({
          chipType,
          challengedTeamId: validatedChallengedTeamId,
          updatedAt: new Date(),
        })
        .where(eq(gameweekChips.id, existingChip.id));

      return NextResponse.json({
        success: true,
        message: `Chip switched to ${chipName} for GW${gameweekNumber}`,
        chip: {
          id: existingChip.id,
          type: chipType,
          name: chipName,
          gameweek: gameweekNumber,
          wasSwitched: true,
        },
      });
    }

    // Create new chip submission
    const chipId = generateId();
    await db.insert(gameweekChips).values({
      id: chipId,
      teamId: teamId,
      gameweekId: gw.id,
      chipType,
      challengedTeamId: validatedChallengedTeamId,
      isValid: true,
      isProcessed: false,
    });

    return NextResponse.json({
      success: true,
      message: `${chipName} submitted for GW${gameweekNumber}`,
      chip: {
        id: chipId,
        type: chipType,
        name: chipName,
        gameweek: gameweekNumber,
      },
    });
  } catch (error) {
    console.error("Chip submission error:", error);
    return NextResponse.json(
      { error: "Failed to submit chip" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/team/chips
 * Cancel a chip submission for a gameweek (before deadline)
 */
export async function DELETE(request: NextRequest) {
  try {
    // Check if team is logged in
    const teamId = request.headers.get("x-session-id");
    if (!teamId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const { gameweek } = body;

    if (!gameweek) {
      return NextResponse.json(
        { error: "gameweek is required" },
        { status: 400 }
      );
    }

    const gameweekNumber = parseInt(gameweek);

    // Get gameweek
    const gw = await db.query.gameweeks.findFirst({
      where: eq(gameweeks.number, gameweekNumber),
    });

    if (!gw) {
      return NextResponse.json({ error: "Gameweek not found" }, { status: 404 });
    }

    // Check deadline
    const now = new Date();
    if (gw.deadline && gw.deadline < now) {
      return NextResponse.json(
        { error: "Cannot cancel chip after deadline has passed" },
        { status: 400 }
      );
    }

    // Find the chip submission
    const existingChip = await db.query.gameweekChips.findFirst({
      where: and(
        eq(gameweekChips.teamId, teamId),
        eq(gameweekChips.gameweekId, gw.id),
        eq(gameweekChips.isProcessed, false)
      ),
    });

    if (!existingChip) {
      return NextResponse.json(
        { error: "No chip submission found for this gameweek" },
        { status: 404 }
      );
    }

    // Delete the chip
    await db.delete(gameweekChips).where(eq(gameweekChips.id, existingChip.id));

    return NextResponse.json({
      success: true,
      message: `Chip cancelled for GW${gameweekNumber}`,
    });
  } catch (error) {
    console.error("Chip cancellation error:", error);
    return NextResponse.json(
      { error: "Failed to cancel chip" },
      { status: 500 }
    );
  }
}
