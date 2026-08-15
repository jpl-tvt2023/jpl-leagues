import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  leagues, groups, teams, players, gameweeks, fixtures, results,
  gameweekChips, playoffTies, challengerSurvivalEntries, leagueAdmins, settings, users,
  auctionBids, auctionWishlists, auctionOwnership, auctionScores, auctionSessions, tradeProposals,
} from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import bcrypt from "bcryptjs";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { validateEnabledChipsArray } from "@/lib/formats/tvt/chip-validation";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await request.json();

  const updates: { name?: string; season?: string; isActive?: boolean; enabledChips?: string } = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.season === "string") updates.season = body.season;
  if (typeof body.isActive === "boolean") updates.isActive = body.isActive;

  // enabledChips is only meaningful for TVT leagues and must match the same
  // shape rule the POST handler enforces (3 unique entries from
  // {W,D,C,SL,CB,UD}). Reject any attempt to set it on non-TVT leagues so the
  // hardcoded [] used for Continental Championship / Auction cannot be silently overwritten.
  if (body.enabledChips !== undefined) {
    const leagueRow = await db
      .select({ format: leagues.format })
      .from(leagues)
      .where(eq(leagues.id, id))
      .limit(1);
    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }
    if (leagueRow[0].format !== "tvt") {
      return NextResponse.json(
        { error: "enabledChips can only be updated on TVT leagues" },
        { status: 400 }
      );
    }
    const chipCheck = validateEnabledChipsArray(body.enabledChips);
    if (!chipCheck.ok) {
      return NextResponse.json({ error: chipCheck.error }, { status: 400 });
    }
    updates.enabledChips = JSON.stringify(chipCheck.chips);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  await db.update(leagues).set(updates).where(eq(leagues.id, id));
  await invalidateLeaguePageCache(id);
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
    // 7. Auction data (FK: league, team, session, gameweek). Order matters:
    //    bids → wishlists → ownership → scores → trade proposals → sessions.
    await tx.delete(auctionBids).where(eq(auctionBids.leagueId, id));
    await tx.delete(auctionWishlists).where(eq(auctionWishlists.leagueId, id));
    await tx.delete(auctionOwnership).where(eq(auctionOwnership.leagueId, id));
    await tx.delete(auctionScores).where(eq(auctionScores.leagueId, id));
    await tx.delete(tradeProposals).where(eq(tradeProposals.leagueId, id));
    await tx.delete(auctionSessions).where(eq(auctionSessions.leagueId, id));
    // 8. Settings (depend on league)
    await tx.delete(settings).where(eq(settings.leagueId, id));
    // 9. League admins (depend on league)
    await tx.delete(leagueAdmins).where(eq(leagueAdmins.leagueId, id));
    // 10. Teams (depend on groups + league)
    await tx.delete(teams).where(eq(teams.leagueId, id));
    // 11. Groups (depend on league)
    await tx.delete(groups).where(eq(groups.leagueId, id));
    // 12. Gameweeks (depend on league)
    await tx.delete(gameweeks).where(eq(gameweeks.leagueId, id));
    // 13. League itself
    await tx.delete(leagues).where(eq(leagues.id, id));
  });

  return NextResponse.json({
    success: true,
    message: `League "${leagueRow[0].name}" and all its data have been permanently deleted.`,
  });
}
