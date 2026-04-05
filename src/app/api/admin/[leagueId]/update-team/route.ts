import { NextRequest, NextResponse } from "next/server";
import { db, teams, players, groups } from "@/lib/db";
import { eq, and, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
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
      abbreviation,
      password, // Optional - only update if provided
      player1Id,
      player1Name,
      player1FplId,
      player2Id,
      player2Name,
      player2FplId,
      group,
    } = body;

    // Validate required fields
    if (!teamId || !teamLoginId || !teamName || !abbreviation || !player1Name || !player1FplId || !player2Name || !player2FplId || !group) {
      return NextResponse.json(
        { error: "All fields except password are required" },
        { status: 400 }
      );
    }

    // Validate teamLoginId format
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(teamLoginId)) {
      return NextResponse.json(
        { error: "Team ID must be 3–20 alphanumeric/underscore/hyphen characters" },
        { status: 400 }
      );
    }

    // Validate group
    if (group !== "A" && group !== "B") {
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

    // Global uniqueness check on teamLoginId (unless it's the same team's current login ID)
    const conflictingLoginId = await db.select().from(teams).where(
      eq(teams.teamLoginId, teamLoginId)
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

    // Ensure group exists for this league
    let groupRecords = await db.select().from(groups).where(
      and(eq(groups.name, group), eq(groups.leagueId, leagueId))
    );
    let groupRecord = groupRecords[0];

    if (!groupRecord) {
      const groupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      await db.insert(groups).values({ id: groupId, name: group, leagueId, groupType: "pl" });
      groupRecord = { id: groupId, name: group, leagueId, groupType: "pl" };
    }

    // Update team
    const updateData: Record<string, unknown> = {
      teamLoginId,
      name: teamName,
      abbreviation: abbreviation.toUpperCase(),
      groupId: groupRecord.id,
    };

    // Only update password if provided
    if (password && password.trim() !== "") {
      updateData.password = await bcrypt.hash(password, 10);
      updateData.mustChangePassword = true;
    }

    await db.update(teams).set(updateData).where(eq(teams.id, teamId));

    // Update players
    if (player1Id) {
      await db.update(players).set({
        name: player1Name,
        fplId: player1FplId,
      }).where(eq(players.id, player1Id));
    }

    if (player2Id) {
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
