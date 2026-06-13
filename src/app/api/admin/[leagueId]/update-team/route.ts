import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups, leagues } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { generateId } from "@/lib/id";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

/**
 * PUT /api/admin/[leagueId]/update-team
 * Admin-only endpoint to update team details
 */
export async function PUT(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const {
      teamId,
      teamLoginId,
      teamName,
      password, // Optional - only update if provided
      player1Id,
      player1Name,
      player1FplId,
      player2Id,
      player2Name,
      player2FplId,
      group,
    } = body;
    // Distinguish "group not provided" from "group explicitly set to empty".
    // Only mutate groupId when the client actually included a `group` key.
    const groupProvided = Object.prototype.hasOwnProperty.call(body, "group");

    // Validate required fields (player fields, password, and group are optional)
    if (!teamId || !teamLoginId || !teamName) {
      return NextResponse.json(
        { error: "Team ID, Login ID, and Name are required" },
        { status: 400 }
      );
    }

    // Validate teamLoginId format
    if (!/^[A-Za-z0-9_-]{3,30}$/.test(teamLoginId)) {
      return NextResponse.json(
        { error: "Team ID must be 3–30 alphanumeric/underscore/hyphen characters" },
        { status: 400 }
      );
    }

    // Preserve the submitted casing for storage; the lowercased copy is used only
    // for the case-insensitive uniqueness check below. (Login is case-insensitive.)
    const trimmedLoginId = String(teamLoginId).trim();
    const normalizedLoginId = trimmedLoginId.toLowerCase();

    // Check league format — auction leagues don't use groups
    const leagueRow = await db.select({ format: leagues.format }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
    const isAuction = leagueRow[0]?.format === "auction";

    // Validate group: only when the client actually sent a `group` key AND the
    // league uses the A/B PL grouping (TVT-16 / similar). Triple Crown, TVT-32,
    // and auction leagues use different group concepts (cup groups, multi-letter
    // groups, or none) — for those, the team's groupId is preserved as-is and
    // the validator is skipped entirely.
    if (groupProvided && !isAuction && group && group !== "A" && group !== "B") {
      return NextResponse.json(
        { error: "Group must be either A or B" },
        { status: 400 }
      );
    }

    // Check if team exists and belongs to authorized league
    const existingTeam = await db.select().from(teams).where(and(eq(teams.id, teamId), eq(teams.leagueId, leagueId)));
    if (existingTeam.length === 0) {
      return NextResponse.json(
        { error: "Team not found" },
        { status: 404 }
      );
    }

    // Block edits to Triple Crown ghost-team placeholders. Ghosts are managed
    // automatically by cup-group generation; renaming or assigning a login ID
    // to one would break the bye-week schedule. Mirrors the delete-team guard.
    if (existingTeam[0].isGhost) {
      return NextResponse.json(
        { error: "Cannot edit a ghost team (Triple Crown bye placeholder). Ghost teams are managed automatically by cup group generation." },
        { status: 400 }
      );
    }

    // Global uniqueness check on teamLoginId (case-insensitive; unless it's the same team's current login ID)
    const conflictingLoginId = await db.select().from(teams).where(
      sql`LOWER(${teams.teamLoginId}) = ${normalizedLoginId}`
    );
    if (conflictingLoginId.length > 0 && conflictingLoginId[0].id !== teamId) {
      return NextResponse.json(
        { error: "Team ID already exists globally" },
        { status: 400 }
      );
    }

    // Check if new team name conflicts with another team in this league (case-insensitive)
    const conflictingTeam = await db.select().from(teams).where(
      and(sql`LOWER(REPLACE(${teams.name}, ' ', '')) = LOWER(REPLACE(${teamName}, ' ', ''))`, eq(teams.leagueId, leagueId))
    );
    if (conflictingTeam.length > 0 && conflictingTeam[0].id !== teamId) {
      return NextResponse.json(
        { error: "Team name already exists in this league" },
        { status: 400 }
      );
    }

    // Resolve group (null if not provided or auction format)
    let groupId: string | null = null;
    if (!isAuction && group && group !== "Unassigned") {
      const groupRecords = await db.select().from(groups).where(
        and(eq(groups.name, group), eq(groups.leagueId, leagueId))
      );
      const groupRecord = groupRecords[0];

      if (!groupRecord) {
        groupId = generateId();
        await db.insert(groups).values({ id: groupId, name: group, leagueId, groupType: "pl" });
      } else {
        groupId = groupRecord.id;
      }
    }

    // Update team
    const updateData: Record<string, unknown> = {
      teamLoginId: trimmedLoginId,
      name: teamName,
    };

    // Only mutate groupId when the client actually sent a `group` key and the
    // league uses groups at all. Otherwise preserve the existing groupId
    // (important for TC / TVT-32 where the modal hides the Group field).
    if (groupProvided && !isAuction) {
      updateData.groupId = groupId;
    }

    // Only update password if provided. Match bulk-upload-teams' 4-char minimum
    // so the single-team-edit path cannot drop below the platform's import-side guarantee.
    if (password && password.trim() !== "") {
      if (String(password).length < 4) {
        return NextResponse.json(
          { error: "Password must be at least 4 characters" },
          { status: 400 }
        );
      }
      updateData.password = await bcrypt.hash(password, 10);
      updateData.mustChangePassword = true;
    }

    await db.update(teams).set(updateData).where(eq(teams.id, teamId));

    // Update players (only if player data is provided)
    if (player1Name && player1FplId && player1Id) {
      await db.update(players).set({
        name: player1Name,
        fplId: player1FplId,
      }).where(eq(players.id, player1Id));
    }

    if (player2Name && player2FplId && player2Id) {
      await db.update(players).set({
        name: player2Name,
        fplId: player2FplId,
      }).where(eq(players.id, player2Id));
    }

    await invalidateLeaguePageCache(leagueId);
    return NextResponse.json({
      success: true,
      message: "Team updated successfully",
    });
  } catch (error) {
    console.error("Error updating team:", error);
    return NextResponse.json(
      { error: "Failed to update team" },
      { status: 500 }
    );
  }
}
