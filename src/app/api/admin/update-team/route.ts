import { NextRequest, NextResponse } from "next/server";
import { db, users, teams, players, groups } from "@/lib/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";

/**
 * PUT /api/admin/update-team
 * Admin-only endpoint to update team details
 */
export async function PUT(request: NextRequest) {
  try {
    // Check if user is admin
    // Admin verified by middleware; defense-in-depth check
    const sessionType = request.headers.get("x-session-type");
    if (sessionType !== "admin" && sessionType !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    const body = await request.json();
    const {
      teamId,
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
    if (!teamId || !teamName || !abbreviation || !player1Name || !player1FplId || !player2Name || !player2FplId || !group) {
      return NextResponse.json(
        { error: "All fields except password are required" },
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

    // Check if team exists
    const existingTeam = await db.select().from(teams).where(eq(teams.id, teamId));
    if (existingTeam.length === 0) {
      return NextResponse.json(
        { error: "Team not found" },
        { status: 404 }
      );
    }

    // Check if new team name conflicts with another team
    const conflictingTeam = await db.select().from(teams).where(eq(teams.name, teamName));
    if (conflictingTeam.length > 0 && conflictingTeam[0].id !== teamId) {
      return NextResponse.json(
        { error: "Team name already exists" },
        { status: 400 }
      );
    }

    // Ensure group exists
    let groupRecords = await db.select().from(groups).where(eq(groups.name, group));
    let groupRecord = groupRecords[0];
    
    if (!groupRecord) {
      const groupId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      await db.insert(groups).values({ id: groupId, name: group });
      groupRecord = { id: groupId, name: group };
    }

    // Update team
    const updateData: Record<string, unknown> = {
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
