/**
 * POST /api/admin/[leagueId]/generate-brackets
 * Continental Championship: Generate JCL/JEL bracket seeds after GW24
 *
 * Flow:
 * 1. Fetch cup group standings at end of GW24
 * 2. Extract JCL (ranks 1-2 from each group) and JEL (ranks 3-4)
 * 3. Seed QF matches with cross-group pairing
 * 4. Create playoffTies and fixtures for JCL/JEL QF (2-legged, GW27/GW29)
 * 5. competitionType="jcl-knockout" or "jel-knockout"
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

    if (leagueRow[0].format !== "continental-championship") {
      return NextResponse.json({
        error: "Bracket generation only available for Continental Championship format",
      }, { status: 400 });
    }

    // Check if JCL/JEL QF ties already exist
    const existingJcl = await db.select().from(playoffTies).where(
      and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jcl-knockout"))
    );
    const existingJel = await db.select().from(playoffTies).where(
      and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jel-knockout"))
    );

    if (existingJcl.length > 0 || existingJel.length > 0) {
      return NextResponse.json({
        error: "JCL/JEL brackets already exist. Delete them first to reseed.",
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

    // Extract JCL (ranks 1-2) and JEL (ranks 3-4)
    const jclTeams = allGroupStandings.flatMap((g, idx) => g.standings.slice(0, 2));
    const jelTeams = allGroupStandings.flatMap((g, idx) => g.standings.slice(2, 4));

    if (jclTeams.length < 8 || jelTeams.length < 8) {
      return NextResponse.json({
        error: `Invalid team counts for brackets: JCL=${jclTeams.length}, JEL=${jelTeams.length}`,
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
      and(eq(groups.leagueId, leagueId), eq(groups.groupType, "jpl"))
    );
    // fixtures.groupId is `references(() => groups.id, { onDelete: "set null" })`
    // so null is a valid value — use it when there is no PL group instead of
    // generating a phantom id that points at no row (FK violation on insert,
    // or orphan reference if the constraint is somehow bypassed).
    const plGroupId: string | null = plGroup[0]?.id ?? null;

    // Create JCL QF ties (cross-group pairing)
    const jclQfMatches = [
      { tieId: "JCL-QF-1", home: jclTeams[0], away: jclTeams[5] },
      { tieId: "JCL-QF-2", home: jclTeams[1], away: jclTeams[4] },
      { tieId: "JCL-QF-3", home: jclTeams[2], away: jclTeams[7] },
      { tieId: "JCL-QF-4", home: jclTeams[3], away: jclTeams[6] },
    ];

    // Create JEL QF ties (cross-group pairing)
    const jelQfMatches = [
      { tieId: "JEL-QF-1", home: jelTeams[0], away: jelTeams[5] },
      { tieId: "JEL-QF-2", home: jelTeams[1], away: jelTeams[4] },
      { tieId: "JEL-QF-3", home: jelTeams[2], away: jelTeams[7] },
      { tieId: "JEL-QF-4", home: jelTeams[3], away: jelTeams[6] },
    ];

    const createdTies: string[] = [];
    const createdFixtures: string[] = [];

    // Create JCL QF ties and fixtures
    for (const match of jclQfMatches) {
      const homeTeam = await db.select().from(teams).where(eq(teams.id, match.home.teamId));
      const awayTeam = await db.select().from(teams).where(eq(teams.id, match.away.teamId));

      if (!homeTeam[0] || !awayTeam[0]) continue;

      await db.insert(playoffTies).values({
        tieId: match.tieId,
        leagueId,
        roundName: "JCL-QF",
        roundType: "jcl-knockout",
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
        roundName: "JCL-QF",
        leg: 1,
        tieId: match.tieId,
        roundType: "jcl-knockout",
        competitionType: "jcl-knockout",
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
        roundName: "JCL-QF",
        leg: 2,
        tieId: match.tieId,
        roundType: "jcl-knockout",
        competitionType: "jcl-knockout",
      });
      createdFixtures.push(leg2Id);
    }

    // Create JEL QF ties and fixtures
    for (const match of jelQfMatches) {
      const homeTeam = await db.select().from(teams).where(eq(teams.id, match.home.teamId));
      const awayTeam = await db.select().from(teams).where(eq(teams.id, match.away.teamId));

      if (!homeTeam[0] || !awayTeam[0]) continue;

      await db.insert(playoffTies).values({
        tieId: match.tieId,
        leagueId,
        roundName: "JEL-QF",
        roundType: "jel-knockout",
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
        roundName: "JEL-QF",
        leg: 1,
        tieId: match.tieId,
        roundType: "jel-knockout",
        competitionType: "jel-knockout",
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
        roundName: "JEL-QF",
        leg: 2,
        tieId: match.tieId,
        roundType: "jel-knockout",
        competitionType: "jel-knockout",
      });
      createdFixtures.push(leg2Id);
    }

    await invalidateLeaguePageCache(leagueId);

    return NextResponse.json({
      success: true,
      message: `Generated JCL/JEL brackets with ${createdTies.length} ties and ${createdFixtures.length} fixtures`,
      summary: {
        jclQfTies: 4,
        jelQfTies: 4,
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
 * Delete all JCL/JEL knockout ties + their fixtures + results so brackets can be reseeded.
 * Used by the "Delete & Regenerate JCL/JEL Brackets" admin button.
 */
export async function DELETE(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const ties = await db.select({ tieId: playoffTies.tieId }).from(playoffTies).where(
      and(
        eq(playoffTies.leagueId, leagueId),
        inArray(playoffTies.roundType, ["jcl-knockout", "jel-knockout"]),
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
    console.error("Error deleting JCL/JEL brackets:", error);
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

    const jclTies = await db.select().from(playoffTies).where(
      and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jcl-knockout"))
    );
    const jelTies = await db.select().from(playoffTies).where(
      and(eq(playoffTies.leagueId, leagueId), eq(playoffTies.roundType, "jel-knockout"))
    );

    return NextResponse.json({
      bracketsGenerated: jclTies.length > 0 && jelTies.length > 0,
      jclQfTies: jclTies.length,
      jelQfTies: jelTies.length,
    });
  } catch (error) {
    console.error("Error checking bracket status:", error);
    return NextResponse.json(
      { error: "Failed to check bracket status" },
      { status: 500 }
    );
  }
}
