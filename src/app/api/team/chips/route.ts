import { NextRequest, NextResponse } from "next/server";
import { db, teams, gameweeks, gameweekChips, settings, leagues, fixtures, auditLogs } from "@/lib/db";
import { eq, and, asc } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { getChipSet } from "@/lib/formats/tvt/scoring";
import { resolveSubmissionWindow, formatLateness } from "@/lib/gameweek-window";
import { getFinishedGwNumbers } from "@/lib/gameweeks/finished-set";
import { getDoublePointerEligibility } from "@/lib/formats/tvt/double-pointer-eligibility";
import { CHIP_GW1_POSITION_REASON } from "@/lib/formats/tvt/chip-validation";

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

/**
 * POST /api/team/chips
 * Submit a TVT chip for a gameweek.
 * The requested GW must be the currently open submission window (deadline
 * not yet passed, and past its own 30-minute post-deadline lock) — anything
 * else is hard-rejected with a message proving how late/mistimed the
 * request was, and recorded in the audit log.
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

    // Get league config (format + enabledChips + playoffStartGw)
    const leagueRow = await db.select({ format: leagues.format, enabledChips: leagues.enabledChips, playoffStartGw: leagues.playoffStartGw })
      .from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }
    // Auction format has no TVT-chip mechanics — guard so an auction team
    // can't POST a chip row (the scoring engine wouldn't ever process it,
    // but the row would still sit in gameweekChips).
    if (leagueRow[0].format === "auction") {
      return NextResponse.json(
        { error: "TVT chips are not available in auction-format leagues" },
        { status: 400 }
      );
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

    // Check if chip announcements are enabled for this league
    const chipSetting = await db.select().from(settings)
      .where(and(eq(settings.key, "chipAnnouncementEnabled"), eq(settings.leagueId, team.leagueId)))
      .limit(1);
    if (chipSetting.length > 0 && chipSetting[0].value === "false") {
      return NextResponse.json(
        { error: "Chip announcements are currently disabled by the admin" },
        { status: 403 }
      );
    }

    // The requested GW must be exactly the currently open submission window.
    // Anything else (deadline already passed, still in its post-deadline
    // lock, or not yet the open GW) is rejected with proof of timing.
    const allLeagueGws = await db.query.gameweeks.findMany({
      where: eq(gameweeks.leagueId, team.leagueId),
      orderBy: asc(gameweeks.number),
    });
    const now = new Date();
    const finishedGws = await getFinishedGwNumbers();
    const window = resolveSubmissionWindow(allLeagueGws, now, finishedGws, {
      requirePreviousFinished: leagueRow[0].format === "tvt",
    });

    if (window.state !== "open" || window.gw?.number !== gameweekNumber) {
      const deadline = new Date(gw.deadline);
      const isLate = deadline <= now;
      const message = isLate
        ? `GW${gameweekNumber}'s deadline (${deadline.toISOString()}) passed ${formatLateness(now.getTime() - deadline.getTime())} before your submission arrived at ${now.toISOString()} — rejected.`
        : window.state === "awaiting-results"
        ? `GW${gameweekNumber} is not open yet: FPL has not marked GW${window.awaitingGw} finished. Double Pointer and Challenge Chip depend on the final league table, so declarations open once GW${window.awaitingGw} is settled.`
        : `GW${gameweekNumber} is not currently open for submissions.`;

      await db.insert(auditLogs).values({
        id: generateId(),
        type: "LATE_ATTEMPT",
        description: `Team ${team.name} attempted a chip submission (${CHIP_NAMES[chipType as ChipCode] ?? chipType}) for GW${gameweekNumber} at ${now.toISOString()} (deadline was ${deadline.toISOString()}).`,
        teamId: team.id,
        gameweekId: gw.id,
        pointsAffected: 0,
      });

      return NextResponse.json({ error: message }, { status: 400 });
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

    // Double Pointer has a rank-based restriction on top of set usage: Top-8
    // teams may only Double-Point a Top-8 opponent, rank 9+ only a strictly
    // higher-ranked opponent (no restriction in playoffs, handled inside the
    // helper). Enforced here so a client can't bypass the UI's disabled state.
    if (chipType === "D") {
      const teamWithFixture = await db.query.teams.findFirst({
        where: eq(teams.id, teamId),
        with: {
          homeFixtures: { where: eq(fixtures.gameweekId, gw.id) },
          awayFixtures: { where: eq(fixtures.gameweekId, gw.id) },
        },
      });
      const opponentTeamId =
        teamWithFixture?.homeFixtures[0]?.awayTeamId ??
        teamWithFixture?.awayFixtures[0]?.homeTeamId ??
        null;

      const eligibility = await getDoublePointerEligibility(
        teamId, team.groupId!, opponentTeamId, gameweekNumber, playoffStartGw
      );
      if (!eligibility.eligible) {
        return NextResponse.json({ error: eligibility.reason }, { status: 400 });
      }
    }

    // Challenge Chip's "top 2 from opposite group" target is just as
    // position-dependent as Double Pointer's rank check (see
    // CHIP_GW1_POSITION_REASON) — block it in GW1 server-side too, so the
    // API can't be hit directly to bypass the dashboard's disabled state.
    if (chipType === "C" && gameweekNumber === 1) {
      return NextResponse.json({ error: CHIP_GW1_POSITION_REASON }, { status: 400 });
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
        { error: `${chipName} is already selected for GW${gameweekNumber}` },
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

    // Load team to scope gameweek lookup by leagueId
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
    });

    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }

    // Load league config (playoffStartGw drives dynamic set boundaries; format
    // decides whether the previous GW must be FPL-finished before the window opens)
    const leagueRow = await db.select({ format: leagues.format, playoffStartGw: leagues.playoffStartGw })
      .from(leagues).where(eq(leagues.id, team.leagueId)).limit(1);
    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }
    const playoffStartGw = leagueRow[0].playoffStartGw ?? 31;

    // Get gameweek (must be in this team's league)
    const gw = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, gameweekNumber), eq(gameweeks.leagueId, team.leagueId)),
    });

    if (!gw) {
      return NextResponse.json({ error: "Gameweek not found" }, { status: 404 });
    }

    // Cancelling is governed by exactly the same window as submitting. This
    // used to check only `gw.deadline < now`, which let a team withdraw a chip
    // for a gameweek that was no longer the open one.
    const now = new Date();
    const allLeagueGws = await db.query.gameweeks.findMany({
      where: eq(gameweeks.leagueId, team.leagueId),
      orderBy: asc(gameweeks.number),
    });
    const finishedGws = await getFinishedGwNumbers();
    const window = resolveSubmissionWindow(allLeagueGws, now, finishedGws, {
      requirePreviousFinished: leagueRow[0].format === "tvt",
    });

    if (window.state !== "open" || window.gw?.number !== gameweekNumber) {
      const message =
        gw.deadline && gw.deadline < now
          ? "Cannot cancel chip after deadline has passed"
          : `GW${gameweekNumber} is not currently open for submissions.`;
      return NextResponse.json({ error: message }, { status: 400 });
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

    // Resolve which teams.*Set<N>Used column the cancelled chip occupies
    const chipSet = getChipSet(gameweekNumber, playoffStartGw);
    const chipCols = CHIP_SET_COL[existingChip.chipType as ChipCode];
    const flagCol = chipSet === 1 ? chipCols?.[0] : chipSet === 2 ? chipCols?.[1] : undefined;

    // Delete the chip and clear the set-used flag atomically
    await db.transaction(async (tx) => {
      await tx.delete(gameweekChips).where(eq(gameweekChips.id, existingChip.id));
      if (flagCol) {
        await tx.update(teams)
          .set({ [flagCol]: false })
          .where(eq(teams.id, teamId));
      }
    });

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
