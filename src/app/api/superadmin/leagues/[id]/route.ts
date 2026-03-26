import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  leagues, groups, teams, players, gameweeks, fixtures, results,
  gameweekChips, playoffTies, challengerSurvivalEntries, leagueAdmins, settings, users,
} from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import bcrypt from "bcryptjs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await request.json();

  const updates: { name?: string; season?: string; isActive?: boolean } = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.season === "string") updates.season = body.season;
  if (typeof body.isActive === "boolean") updates.isActive = body.isActive;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  await db.update(leagues).set(updates).where(eq(leagues.id, id));
  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/superadmin/leagues/[id]
 * Permanently delete a league and ALL its data.
 * Requires the superadmin's own password in the request body for confirmation.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const superadminUserId = request.headers.get("x-session-id");
  if (!superadminUserId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();
  const { password } = body;

  if (!password) {
    return NextResponse.json({ error: "Password is required to confirm deletion" }, { status: 400 });
  }

  // Verify the superadmin's own password
  const userRow = await db.select({ password: users.password }).from(users).where(eq(users.id, superadminUserId)).limit(1);
  if (userRow.length === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const passwordValid = await bcrypt.compare(password, userRow[0].password);
  if (!passwordValid) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 403 });
  }

  // Verify the league exists
  const leagueRow = await db.select({ id: leagues.id, name: leagues.name }).from(leagues).where(eq(leagues.id, id)).limit(1);
  if (leagueRow.length === 0) {
    return NextResponse.json({ error: "League not found" }, { status: 404 });
  }

  // Gather IDs needed for cascade
  const leagueGameweeks = await db.select({ id: gameweeks.id }).from(gameweeks).where(eq(gameweeks.leagueId, id));
  const gwIds = leagueGameweeks.map(g => g.id);

  const leagueTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.leagueId, id));
  const teamIds = leagueTeams.map(t => t.id);

  const leagueFixtures = gwIds.length > 0
    ? await db.select({ id: fixtures.id }).from(fixtures).where(inArray(fixtures.gameweekId, gwIds))
    : [];
  const fixtureIds = leagueFixtures.map(f => f.id);

  await db.transaction(async (tx) => {
    // 1. Results (depend on fixtures)
    if (fixtureIds.length > 0) {
      await tx.delete(results).where(inArray(results.fixtureId, fixtureIds));
    }
    // 2. Challenger survival entries (depend on gameweeks + teams)
    if (gwIds.length > 0) {
      await tx.delete(challengerSurvivalEntries).where(inArray(challengerSurvivalEntries.gameweekId, gwIds));
    }
    // 3. Gameweek chips (depend on teams)
    if (teamIds.length > 0) {
      await tx.delete(gameweekChips).where(inArray(gameweekChips.teamId, teamIds));
    }
    // 4. Fixtures (depend on gameweeks)
    if (fixtureIds.length > 0) {
      await tx.delete(fixtures).where(inArray(fixtures.id, fixtureIds));
    }
    // 5. Playoff ties (depend on league)
    await tx.delete(playoffTies).where(eq(playoffTies.leagueId, id));
    // 6. Players (depend on teams)
    if (teamIds.length > 0) {
      await tx.delete(players).where(inArray(players.teamId, teamIds));
    }
    // 7. Settings (depend on league)
    await tx.delete(settings).where(eq(settings.leagueId, id));
    // 8. League admins (depend on league)
    await tx.delete(leagueAdmins).where(eq(leagueAdmins.leagueId, id));
    // 9. Teams (depend on groups + league)
    await tx.delete(teams).where(eq(teams.leagueId, id));
    // 10. Groups (depend on league)
    await tx.delete(groups).where(eq(groups.leagueId, id));
    // 11. Gameweeks (depend on league)
    await tx.delete(gameweeks).where(eq(gameweeks.leagueId, id));
    // 12. League itself
    await tx.delete(leagues).where(eq(leagues.id, id));
  });

  return NextResponse.json({
    success: true,
    message: `League "${leagueRow[0].name}" and all its data have been permanently deleted.`,
  });
}
