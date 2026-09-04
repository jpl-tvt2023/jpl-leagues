import { NextRequest, NextResponse } from "next/server";
import { db, teams, auditLogs, gameweekChips, gameweeks } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { generateId } from "@/lib/id";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { isChipWasted } from "@/lib/formats/tvt/chip-waste";

// Valid chip types (existing + 3 new chips)
const VALID_CHIPS = [
  "doublePointerSet1",
  "challengeChipSet1",
  "winWinSet1",
  "scoreLockSet1",
  "comebackSet1",
  "underdogSet1",
  "doublePointerSet2",
  "challengeChipSet2",
  "winWinSet2",
  "scoreLockSet2",
  "comebackSet2",
  "underdogSet2",
] as const;

type ChipType = typeof VALID_CHIPS[number];

// Map chip type to database column
const chipToColumn: Record<ChipType, keyof typeof teams.$inferSelect> = {
  doublePointerSet1: "doublePointerSet1Used",
  challengeChipSet1: "challengeChipSet1Used",
  winWinSet1: "winWinSet1Used",
  scoreLockSet1: "scoreLockSet1Used",
  comebackSet1: "comebackSet1Used",
  underdogSet1: "underdogSet1Used",
  doublePointerSet2: "doublePointerSet2Used",
  challengeChipSet2: "challengeChipSet2Used",
  winWinSet2: "winWinSet2Used",
  scoreLockSet2: "scoreLockSet2Used",
  comebackSet2: "comebackSet2Used",
  underdogSet2: "underdogSet2Used",
};

// Map chip column key to gameweekChips chipType code
const chipToTypeCode: Record<ChipType, string> = {
  doublePointerSet1: "D", challengeChipSet1: "C", winWinSet1: "W",
  scoreLockSet1: "SL", comebackSet1: "CB", underdogSet1: "UD",
  doublePointerSet2: "D", challengeChipSet2: "C", winWinSet2: "W",
  scoreLockSet2: "SL", comebackSet2: "CB", underdogSet2: "UD",
};

// Chip display names for UI
const chipDisplayNames: Record<ChipType, string> = {
  doublePointerSet1: "Double Pointer (Set 1)",
  challengeChipSet1: "Challenge Chip (Set 1)",
  winWinSet1: "Win-Win (Set 1)",
  scoreLockSet1: "Score Lock (Set 1)",
  comebackSet1: "Comeback (Set 1)",
  underdogSet1: "Underdog (Set 1)",
  doublePointerSet2: "Double Pointer (Set 2)",
  challengeChipSet2: "Challenge Chip (Set 2)",
  winWinSet2: "Win-Win (Set 2)",
  scoreLockSet2: "Score Lock (Set 2)",
  comebackSet2: "Comeback (Set 2)",
  underdogSet2: "Underdog (Set 2)",
};

/**
 * POST /api/admin/[leagueId]/override-chips
 * Admin-only endpoint to override chip usage for a team
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

    // Validate gameweek is a positive integer (admin overrides don't enforce strict GW windows)
    if (chipStatus !== "available" && gameweek) {
      const gwNum = parseInt(gameweek);
      if (isNaN(gwNum) || gwNum < 1) {
        return NextResponse.json({ error: "Invalid gameweek" }, { status: 400 });
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

    // Get the team and verify it belongs to authorized league
    const teamList = await db.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.leagueId, leagueId)));
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
    const chipCode = chipToTypeCode[chipType as ChipType];

    // Load this league's playoffStartGw so set boundaries match the actual
    // league configuration (TVT-8: playoffStartGw=36 → set1=GW1..17, set2=GW18..35;
    // TVT-16/32: playoffStartGw=31 → set1=GW1..15, set2=GW16..30). Hardcoded
    // 15/30 was wrong for any non-default playoffStartGw.
    const leagueCfg = await db
      .select({ playoffStartGw: leagues.playoffStartGw })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    const playoffStartGw = leagueCfg[0]?.playoffStartGw ?? 31;
    const setMidpoint = Math.ceil((playoffStartGw - 1) / 2);

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

    // Find chips in the target set, using setMidpoint derived from playoffStartGw
    // (set1 = GW1..midpoint; set2 = GW(midpoint+1)..playoffStartGw-1).
    const chipsInSet = existingChips.filter(c => {
      const gwNum = c.gameweeks.number;
      return setNumber === 1
        ? gwNum <= setMidpoint
        : gwNum > setMidpoint && gwNum < playoffStartGw;
    });

    // Delete any existing chip records for this chip type/set
    for (const chip of chipsInSet) {
      await db.delete(gameweekChips)
        .where(eq(gameweekChips.id, chip.gameweek_chips.id));
    }

    // If marking as used or wasted, create a new gameweekChips record
    if (chipStatus !== "available" && gameweek) {
      const gwNum = parseInt(gameweek);

      // Find or create the gameweek record (scoped to the authorized league)
      const gwRecord = await db.select().from(gameweeks).where(and(eq(gameweeks.number, gwNum), eq(gameweeks.leagueId, leagueId)));
      let gameweekId: string;

      if (gwRecord.length === 0) {
        // Create the gameweek record using the league's playoffStartGw for isPlayoffs
        const leagueRecord = await db.select({ playoffStartGw: leagues.playoffStartGw }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
        const playoffStartGw = leagueRecord[0]?.playoffStartGw ?? 31;
        gameweekId = generateId();
        const deadline = new Date();
        deadline.setDate(deadline.getDate() + (7 * gwNum));
        deadline.setHours(11, 0, 0, 0);
        await db.insert(gameweeks).values({
          id: gameweekId,
          number: gwNum,
          leagueId,
          deadline,
          isPlayoffs: gwNum >= playoffStartGw,
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

    await invalidateLeaguePageCache(leagueId);
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
 * GET /api/admin/[leagueId]/override-chips
 * Get all teams and their chip status for admin override
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Get all teams with chip status for this league
    const allTeams = await db.query.teams.findMany({
      where: eq(teams.leagueId, leagueId),
      with: {
        group: true,
      },
    });

    // Get league's playoffStartGw + enabledChips to correctly split Set1/Set2 chips
    // and gate which chip slots the UI sees per league.
    const leagueRow = await db
      .select({ playoffStartGw: leagues.playoffStartGw, enabledChips: leagues.enabledChips })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);
    const playoffStartGw = leagueRow[0]?.playoffStartGw ?? 31;
    const setMidpoint = Math.ceil((playoffStartGw - 1) / 2);
    let enabledChipCodes: string[] = ["D", "W", "C"];
    try {
      enabledChipCodes = JSON.parse(leagueRow[0]?.enabledChips ?? '["D","W","C"]');
    } catch {
      /* keep default on malformed JSON */
    }
    const isEnabled = (code: string) => enabledChipCodes.includes(code);

    // Get chip usage scoped to this league's gameweeks only
    const leagueGws = await db.select({ id: gameweeks.id }).from(gameweeks).where(eq(gameweeks.leagueId, leagueId));
    const leagueGwIds = leagueGws.map(g => g.id);
    const allChipUsage = leagueGwIds.length > 0
      ? await db.query.gameweekChips.findMany({
          where: inArray(gameweekChips.gameweekId, leagueGwIds),
          with: { gameweek: true },
        })
      : [];

    // Create a lookup map: teamId -> chipType -> { gwNumber, wasted, points }
    const chipGwLookup = new Map<string, Map<string, { gwNumber: number; wasted: boolean; points: number }>>();
    for (const chip of allChipUsage) {
      if (!chipGwLookup.has(chip.teamId)) {
        chipGwLookup.set(chip.teamId, new Map());
      }
      const gwNumber = chip.gameweek.number;
      const set = gwNumber <= setMidpoint ? 1 : 2;
      const key = `${chip.chipType}${set}`; // e.g., "W1", "D2", "C1"
      // Waste has three representations in the database and only isChipWasted knows all of
      // them. The expression that used to live here missed `wastedReason` — the one the scorer
      // actually writes — so a chip the scorer burnt showed up on this screen as plain "Used".
      const wasted = isChipWasted(chip);
      chipGwLookup.get(chip.teamId)!.set(key, { gwNumber, wasted, points: chip.pointsAwarded || 0 });
    }

    // Set-range labels derived from the league's actual playoffStartGw, not hardcoded.
    const set1Label = `(GW1-${setMidpoint})`;
    const set2Label = `(GW${setMidpoint + 1}-${playoffStartGw - 1})`;

    // Build a chip slot from the league row's *Used column + the chipGwLookup entry.
    const slot = (
      teamRow: typeof allTeams[number],
      column: keyof typeof teams.$inferSelect,
      code: string,
      set: 1 | 2,
      displayName: string,
    ) => ({
      used: teamRow[column] as boolean,
      name: displayName,
      gameweek: (chipGwLookup.get(teamRow.id)?.get(`${code}${set}`)?.gwNumber) ?? null,
      wasted: (chipGwLookup.get(teamRow.id)?.get(`${code}${set}`)?.wasted) ?? false,
      points: (chipGwLookup.get(teamRow.id)?.get(`${code}${set}`)?.points) ?? 0,
    });

    return NextResponse.json({
      teams: allTeams.map(t => {
        const setChips = (set: 1 | 2, range: string) => {
          const out: Record<string, ReturnType<typeof slot>> = {};
          if (isEnabled("D")) out.doublePointer = slot(t, set === 1 ? "doublePointerSet1Used" : "doublePointerSet2Used", "D", set, `Double Pointer ${range}`);
          if (isEnabled("C")) out.challengeChip = slot(t, set === 1 ? "challengeChipSet1Used" : "challengeChipSet2Used", "C", set, `Challenge Chip ${range}`);
          if (isEnabled("W")) out.winWin = slot(t, set === 1 ? "winWinSet1Used" : "winWinSet2Used", "W", set, `Win-Win ${range}`);
          if (isEnabled("SL")) out.scoreLock = slot(t, set === 1 ? "scoreLockSet1Used" : "scoreLockSet2Used", "SL", set, `Score Lock ${range}`);
          if (isEnabled("CB")) out.comeback = slot(t, set === 1 ? "comebackSet1Used" : "comebackSet2Used", "CB", set, `Comeback ${range}`);
          if (isEnabled("UD")) out.underdog = slot(t, set === 1 ? "underdogSet1Used" : "underdogSet2Used", "UD", set, `Underdog ${range}`);
          return out;
        };
        return {
          id: t.id,
          name: t.name,
          group: t.group?.name || "Unassigned",
          chips: {
            set1: setChips(1, set1Label),
            set2: setChips(2, set2Label),
          },
        };
      }),
      chipTypes: VALID_CHIPS.filter(c => isEnabled(chipToTypeCode[c])).map(c => ({
        value: c,
        label: chipDisplayNames[c],
      })),
      enabledChips: enabledChipCodes,
    });
  } catch (error) {
    console.error("Failed to fetch chip data:", error);
    return NextResponse.json(
      { error: "Failed to fetch data" },
      { status: 500 }
    );
  }
}
