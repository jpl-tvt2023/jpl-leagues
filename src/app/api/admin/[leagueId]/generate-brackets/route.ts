/**
 * POST /api/admin/[leagueId]/generate-brackets
 * Triple Crown: Generate UCL/UEL bracket seeds after GW24
 *
 * Flow:
 * 1. Fetch cup group standings at end of GW24
 * 2. Extract UCL (ranks 1-2 from each group) and UEL (ranks 3-4)
 * 3. Seed QF matches with cross-group pairing
 * 4. Create playoffTies and fixtures for UCL/UEL QF (2-legged, GW27/GW29)
 * 5. competitionType="ucl-knockout" or "uel-knockout"
 */

import { NextRequest, NextResponse } from "next/server";
import { db, teams, fixtures, gameweeks, groups, playoffTies, leagues } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { generateId } from "@/lib/id";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";

interface CupGroupStanding {
  teamId: string;
  name: string;
  isGhost: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Fetch league config
    const leagueRow = await db.select({
      format: leagues.format,
      teamSize: leagues.teamSize,
    }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);

    if (!leagueRow.length) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }

    if (leagueRow[0].format !== "triple-crown") {
      return NextResponse.json({
        error: "Bracket generation only available for Triple Crown format",
      }, { status: 400 });
    }

    // Check if UCL/UEL QF ties already exist
    const existingUcl = await db.select().from(playoffTies).where(
      and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "ucl-knockout"))
    );
    const existingUel = await db.select().from(playoffTies).where(
      and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "uel-knockout"))
    );

    if (existingUcl.length > 0 || existingUel.length > 0) {
      return NextResponse.json({
        error: "UCL/UEL brackets already exist. Delete them first to reseed.",
      }, { status: 400 });
    }

    // Fetch cup groups
    const cupGroups = await db.select().from(groups).where(
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "cup"))
    ).orderBy(groups.name);

    if (cupGroups.length !== 4) {
      return NextResponse.json({
        error: `Expected 4 cup groups, found ${cupGroups.length}. Run "Seed Cup Groups" first.`,
      }, { status: 400 });
    }

    // Compute standings for each cup group (at end of GW24)
    const allGroupStandings = await Promise.all(
      cupGroups.map(async (group) => {
        const groupTeams = await db.select().from(teams).where(eq(teams.groupId, group.id));

        // Fetch all cup group fixtures and results
        const groupFixtures = await db.query.fixtures.findMany({
          where: and(
            eq(fixtures.groupId, group.id),
            eq(fixtures.competitionType, "cup-group")
          ),
          with: { result: true },
        });

        // Build standings from results
        const standings: CupGroupStanding[] = [];
        const teamStats = new Map<string, {
          wins: number;
          draws: number;
          losses: number;
          gf: number;
          ga: number;
          points: number;
        }>();

        for (const team of groupTeams) {
          teamStats.set(team.id, { wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 });
        }

        for (const fixture of groupFixtures) {
          if (fixture.result) {
            const home = teamStats.get(fixture.homeTeamId);
            const away = teamStats.get(fixture.awayTeamId);

            if (home) {
              home.gf += fixture.result.homeScore;
              home.ga += fixture.result.awayScore;
              home.points += fixture.result.homeMatchPoints;
              if (fixture.result.homeMatchPoints === 2) home.wins++;
              else if (fixture.result.homeMatchPoints === 1) home.draws++;
              else home.losses++;
            }

            if (away) {
              away.gf += fixture.result.awayScore;
              away.ga += fixture.result.homeScore;
              away.points += fixture.result.awayMatchPoints;
              if (fixture.result.awayMatchPoints === 2) away.wins++;
              else if (fixture.result.awayMatchPoints === 1) away.draws++;
              else away.losses++;
            }
          }
        }

        // Sort by points
        const sorted = Array.from(teamStats.entries())
          .filter(([teamId]) => {
            const team = groupTeams.find(t => t.id === teamId);
            return team && !team.isGhost;
          })
          .sort(([, a], [, b]) => {
            if (a.points !== b.points) return b.points - a.points;
            if ((b.gf - b.ga) !== (a.gf - a.ga)) return (b.gf - b.ga) - (a.gf - a.ga);
            return b.gf - a.gf;
          });

        return {
          group: group.name,
          standings: sorted.slice(0, 4).map(([teamId, stats]) => {
            const team = groupTeams.find(t => t.id === teamId);
            return {
              teamId,
              name: team?.name || "Unknown",
              isGhost: team?.isGhost || false,
            };
          }),
        };
      })
    );

    if (allGroupStandings.some(g => g.standings.length < 4)) {
      return NextResponse.json({
        error: "Not enough teams ranked in cup groups. Ensure GW24 results are processed.",
      }, { status: 400 });
    }

    // Extract UCL (ranks 1-2) and UEL (ranks 3-4)
    const uclTeams = allGroupStandings.flatMap((g, idx) => g.standings.slice(0, 2));
    const uelTeams = allGroupStandings.flatMap((g, idx) => g.standings.slice(2, 4));

    if (uclTeams.length < 8 || uelTeams.length < 8) {
      return NextResponse.json({
        error: `Invalid team counts for brackets: UCL=${uclTeams.length}, UEL=${uelTeams.length}`,
      }, { status: 400 });
    }

    // Ensure GW27 and GW29 exist
    const gw27 = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, 27), eq(gameweeks.leagueId, leagueId)),
    });
    const gw29 = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, 29), eq(gameweeks.leagueId, leagueId)),
    });

    let gw27Id = gw27?.id;
    let gw29Id = gw29?.id;

    // Anchor synthetic GW deadlines to the league's earliest existing GW1 rather
    // than today, so late-season bracket regeneration doesn't push GW27/GW29
    // ~27 / ~29 weeks past the bracket-gen date.
    const earliestGw = await db.query.gameweeks.findFirst({
      where: eq(gameweeks.leagueId, leagueId),
      orderBy: (g, { asc }) => [asc(g.number)],
    });
    const anchorDate = earliestGw ? new Date(earliestGw.deadline) : new Date();
    const anchorNumber = earliestGw ? earliestGw.number : 1;
    const deadlineForGw = (gwNum: number): Date => {
      const d = new Date(anchorDate);
      d.setDate(d.getDate() + 7 * (gwNum - anchorNumber));
      d.setHours(11, 0, 0, 0);
      return d;
    };

    if (!gw27Id) {
      gw27Id = generateId();
      await db.insert(gameweeks).values({
        id: gw27Id,
        number: 27,
        leagueId,
        deadline: deadlineForGw(27),
        isPlayoffs: true,
      });
    }

    if (!gw29Id) {
      gw29Id = generateId();
      await db.insert(gameweeks).values({
        id: gw29Id,
        number: 29,
        leagueId,
        deadline: deadlineForGw(29),
        isPlayoffs: true,
      });
    }

    const plGroup = await db.select().from(groups).where(
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "pl"))
    );
    const plGroupId = plGroup[0]?.id || generateId();

    // Create UCL QF ties (cross-group pairing)
    const uclQfMatches = [
      { tieId: "UCL-QF-1", home: uclTeams[0], away: uclTeams[5] },
      { tieId: "UCL-QF-2", home: uclTeams[1], away: uclTeams[4] },
      { tieId: "UCL-QF-3", home: uclTeams[2], away: uclTeams[7] },
      { tieId: "UCL-QF-4", home: uclTeams[3], away: uclTeams[6] },
    ];

    // Create UEL QF ties (cross-group pairing)
    const uelQfMatches = [
      { tieId: "UEL-QF-1", home: uelTeams[0], away: uelTeams[5] },
      { tieId: "UEL-QF-2", home: uelTeams[1], away: uelTeams[4] },
      { tieId: "UEL-QF-3", home: uelTeams[2], away: uelTeams[7] },
      { tieId: "UEL-QF-4", home: uelTeams[3], away: uelTeams[6] },
    ];

    const createdTies: string[] = [];
    const createdFixtures: string[] = [];

    // Create UCL QF ties and fixtures
    for (const match of uclQfMatches) {
      const homeTeam = await db.select().from(teams).where(eq(teams.id, match.home.teamId));
      const awayTeam = await db.select().from(teams).where(eq(teams.id, match.away.teamId));

      if (!homeTeam[0] || !awayTeam[0]) continue;

      await db.insert(playoffTies).values({
        tieId: match.tieId,
        leagueId,
        roundName: "UCL-QF",
        roundType: "ucl-knockout",
        homeTeamId: match.home.teamId,
        awayTeamId: match.away.teamId,
        gw1: 27,
        gw2: 29,
        status: "pending",
      });
      createdTies.push(match.tieId);

      // Leg 1
      const leg1Id = generateId();
      await db.insert(fixtures).values({
        id: leg1Id,
        gameweekId: gw27Id,
        homeTeamId: match.home.teamId,
        awayTeamId: match.away.teamId,
        groupId: plGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "UCL-QF",
        leg: 1,
        tieId: match.tieId,
        roundType: "ucl-knockout",
        competitionType: "ucl-knockout",
      });
      createdFixtures.push(leg1Id);

      // Leg 2
      const leg2Id = generateId();
      await db.insert(fixtures).values({
        id: leg2Id,
        gameweekId: gw29Id,
        homeTeamId: match.away.teamId,
        awayTeamId: match.home.teamId,
        groupId: plGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "UCL-QF",
        leg: 2,
        tieId: match.tieId,
        roundType: "ucl-knockout",
        competitionType: "ucl-knockout",
      });
      createdFixtures.push(leg2Id);
    }

    // Create UEL QF ties and fixtures
    for (const match of uelQfMatches) {
      const homeTeam = await db.select().from(teams).where(eq(teams.id, match.home.teamId));
      const awayTeam = await db.select().from(teams).where(eq(teams.id, match.away.teamId));

      if (!homeTeam[0] || !awayTeam[0]) continue;

      await db.insert(playoffTies).values({
        tieId: match.tieId,
        leagueId,
        roundName: "UEL-QF",
        roundType: "uel-knockout",
        homeTeamId: match.home.teamId,
        awayTeamId: match.away.teamId,
        gw1: 27,
        gw2: 29,
        status: "pending",
      });
      createdTies.push(match.tieId);

      // Leg 1
      const leg1Id = generateId();
      await db.insert(fixtures).values({
        id: leg1Id,
        gameweekId: gw27Id,
        homeTeamId: match.home.teamId,
        awayTeamId: match.away.teamId,
        groupId: plGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "UEL-QF",
        leg: 1,
        tieId: match.tieId,
        roundType: "uel-knockout",
        competitionType: "uel-knockout",
      });
      createdFixtures.push(leg1Id);

      // Leg 2
      const leg2Id = generateId();
      await db.insert(fixtures).values({
        id: leg2Id,
        gameweekId: gw29Id,
        homeTeamId: match.away.teamId,
        awayTeamId: match.home.teamId,
        groupId: plGroupId,
        isChallenge: false,
        isPlayoff: true,
        roundName: "UEL-QF",
        leg: 2,
        tieId: match.tieId,
        roundType: "uel-knockout",
        competitionType: "uel-knockout",
      });
      createdFixtures.push(leg2Id);
    }

    await invalidateLeaguePageCache(leagueId);

    return NextResponse.json({
      success: true,
      message: `Generated UCL/UEL brackets with ${createdTies.length} ties and ${createdFixtures.length} fixtures`,
      summary: {
        uclQfTies: 4,
        uelQfTies: 4,
        totalFixtures: createdFixtures.length,
        qfGWs: [27, 29],
      },
    });
  } catch (error) {
    console.error("Error generating brackets:", error);
    return NextResponse.json(
      { error: "Failed to generate brackets" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/[leagueId]/generate-brackets
 * Delete all UCL/UEL knockout ties + their fixtures + results so brackets can be reseeded.
 * Used by the "Delete & Regenerate UCL/UEL Brackets" admin button.
 */
export async function DELETE(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const ties = await db.select({ tieId: playoffTies.tieId }).from(playoffTies).where(
      and(
        eq(playoffTies.leagueId, leagueId),
        inArray(playoffTies.roundType, ["ucl-knockout", "uel-knockout"]),
      ),
    );
    const tieIds = ties.map(t => t.tieId);
    if (tieIds.length === 0) {
      await invalidateLeaguePageCache(leagueId);
      return NextResponse.json({ success: true, message: "No brackets to delete", deletedTies: 0, deletedFixtures: 0 });
    }

    const { results, fixtures: fixturesTable } = await import("@/lib/db/schema");

    const fxRows = await db.select({ id: fixturesTable.id }).from(fixturesTable).where(inArray(fixturesTable.tieId, tieIds));
    const fixtureIds = fxRows.map(f => f.id);

    await db.transaction(async (tx) => {
      if (fixtureIds.length > 0) {
        await tx.delete(results).where(inArray(results.fixtureId, fixtureIds));
        await tx.delete(fixturesTable).where(inArray(fixturesTable.id, fixtureIds));
      }
      await tx.delete(playoffTies).where(inArray(playoffTies.tieId, tieIds));
    });

    await invalidateLeaguePageCache(leagueId);
    return NextResponse.json({
      success: true,
      message: `Deleted ${tieIds.length} ties and ${fixtureIds.length} fixtures`,
      deletedTies: tieIds.length,
      deletedFixtures: fixtureIds.length,
    });
  } catch (error) {
    console.error("Error deleting UCL/UEL brackets:", error);
    return NextResponse.json({ error: "Failed to delete brackets" }, { status: 500 });
  }
}

/**
 * GET /api/admin/[leagueId]/generate-brackets
 * Check bracket generation status
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const uclTies = await db.select().from(playoffTies).where(
      and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "ucl-knockout"))
    );
    const uelTies = await db.select().from(playoffTies).where(
      and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "uel-knockout"))
    );

    return NextResponse.json({
      bracketsGenerated: uclTies.length > 0 && uelTies.length > 0,
      uclQfTies: uclTies.length,
      uelQfTies: uelTies.length,
    });
  } catch (error) {
    console.error("Error checking bracket status:", error);
    return NextResponse.json(
      { error: "Failed to check bracket status" },
      { status: 500 }
    );
  }
}
