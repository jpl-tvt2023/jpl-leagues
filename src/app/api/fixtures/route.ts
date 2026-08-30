import { NextRequest, NextResponse } from "next/server";
import { db, fixtures, teams, gameweeks, groups, results, leagues } from "@/lib/db";
import { gameweekChips } from "@/lib/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getCachedFixtures, setCachedFixtures } from "@/lib/fpl-cache";
import { chipCode, chipName } from "@/lib/formats/tvt/chip-labels";
import { buildChallengeMatches } from "@/lib/formats/tvt/challenge-match-query";
import type { ChallengeMatch } from "@/lib/formats/tvt/challenge-match";

/** One team's chip for one gameweek, as rendered on that team's fixture card. */
export interface FixtureChip {
  chipType: string;
  /** Short pill code, e.g. "CC". */
  chipCode: string;
  /** Full name for the tooltip, e.g. "Challenge Chip". */
  chipName: string;
  /** Challenge Chip only. */
  challengedTeamName?: string;
  /** Challenge Chip only, once both sides of that gameweek are scored. */
  challenge?: ChallengeMatch;
}

/**
 * GET /api/fixtures
 * Get all fixtures, optionally filtered by gameweek
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const gameweekParam = searchParams.get("gameweek");
    const groupParam = searchParams.get("group");
    const leagueSlug = searchParams.get("leagueSlug");

    // leagueSlug is required
    if (!leagueSlug) {
      return NextResponse.json(
        { error: "leagueSlug parameter is required" },
        { status: 400 }
      );
    }

    // Resolve leagueId and config from slug
    const league = await db.select({ id: leagues.id, playoffStartGw: leagues.playoffStartGw, format: leagues.format, enabledChips: leagues.enabledChips }).from(leagues).where(eq(leagues.slug, leagueSlug)).limit(1);
    if (league.length === 0) {
      return NextResponse.json(
        { error: "League not found" },
        { status: 404 }
      );
    }

    const leagueId = league[0].id;
    const playoffStartGw = league[0].playoffStartGw ?? null;
    const format = league[0].format ?? "tvt";
    // Same parse guard the standings route uses.
    let enabledChips: string[] = ["D", "W", "C"];
    try { enabledChips = JSON.parse(league[0].enabledChips ?? '["D","W","C"]'); } catch { /* keep default */ }

    // Return cached fixtures if available — only for unfiltered league requests
    if (leagueId && !gameweekParam && !groupParam) {
      try {
        const cached = await getCachedFixtures(leagueId);
        if (cached) return NextResponse.json(cached);
      } catch {
        // Cache miss or Redis error — fall through to DB computation
      }
    }

    // Pre-fetch this league's gameweek IDs so the fixtures query can be scoped
    // server-side via inArray. Without this we'd load EVERY fixture across every
    // league and filter in memory — slow on multi-league setups, especially when
    // the fixtures-cache is cold.
    const leagueGwRows = await db
      .select({ id: gameweeks.id })
      .from(gameweeks)
      .where(eq(gameweeks.leagueId, leagueId));
    const leagueGwIds = leagueGwRows.map(g => g.id);

    let allFixtures = leagueGwIds.length === 0 ? [] : await db.query.fixtures.findMany({
      where: inArray(fixtures.gameweekId, leagueGwIds),
      with: {
        homeTeam: true,
        awayTeam: true,
        gameweek: true,
        group: true,
        result: true,
      },
    });

    // Filter by gameweek if provided
    if (gameweekParam) {
      const gwNumber = parseInt(gameweekParam);
      allFixtures = allFixtures.filter(f => f.gameweek.number === gwNumber);
    }

    // Filter by group if provided
    if (groupParam && (groupParam === "A" || groupParam === "B")) {
      allFixtures = allFixtures.filter(f => f.group?.name === groupParam);
    }

    // Sort by gameweek number, then group name
    allFixtures.sort((a, b) => {
      if (a.gameweek.number !== b.gameweek.number) {
        return a.gameweek.number - b.gameweek.number;
      }
      const aGroup = a.group?.name || "";
      const bGroup = b.group?.name || "";
      return aGroup.localeCompare(bGroup);
    });

    // Group fixtures by gameweek
    const fixturesByGameweek: Record<number, typeof allFixtures> = {};
    for (const fixture of allFixtures) {
      const gw = fixture.gameweek.number;
      if (!fixturesByGameweek[gw]) {
        fixturesByGameweek[gw] = [];
      }
      fixturesByGameweek[gw].push(fixture);
    }

    // ── Chips played, per gameweek per team ──────────────────────────────
    //
    // ⚠️ Past deadlines ONLY, and this filter is load-bearing. A gameweek_chips row is written
    // when a chip is DECLARED, which can be well before that gameweek's deadline. This payload
    // is public to the whole league, so including a pending row would let a team read their
    // opponent's chip before choosing their own captain. Same rule as the dashboard's
    // pl-fixture route.
    const chipsByGameweek: Record<number, Record<string, FixtureChip>> = {};
    if (format === "tvt" && leagueGwIds.length > 0) {
      const now = new Date();
      const gwRows = await db
        .select({ id: gameweeks.id, number: gameweeks.number, deadline: gameweeks.deadline })
        .from(gameweeks)
        .where(eq(gameweeks.leagueId, leagueId));
      const gwById = new Map(gwRows.map((g) => [g.id, g]));

      const chipRows = await db
        .select()
        .from(gameweekChips)
        .where(and(inArray(gameweekChips.gameweekId, leagueGwIds), eq(gameweekChips.isValid, true)));

      const visible = chipRows.filter((c) => {
        const gw = gwById.get(c.gameweekId);
        if (!gw || gw.deadline > now) return false;      // not public yet
        return enabledChips.includes(c.chipType);
      });

      // Challenge matches are rebuilt from both sides' own results — see challenge-match.ts.
      const challenges = await buildChallengeMatches(
        visible
          .filter((c) => c.chipType === "C")
          .map((c) => ({
            id: c.id,
            teamId: c.teamId,
            challengedTeamId: c.challengedTeamId,
            gameweekId: c.gameweekId,
            pointsAwarded: c.pointsAwarded,
            isProcessed: c.isProcessed,
          })),
      );

      // Resolve target names directly: a challenge that could not be rebuilt (unscored, or a
      // side on a bye) still needs to name who was challenged.
      const targetIds = [...new Set(visible.map((c) => c.challengedTeamId).filter((x): x is string => !!x))];
      const targetRows = targetIds.length
        ? await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, targetIds))
        : [];
      const targetNameById = new Map(targetRows.map((t) => [t.id, t.name]));

      for (const c of visible) {
        const gw = gwById.get(c.gameweekId)!;
        const entry: FixtureChip = {
          chipType: c.chipType,
          chipCode: chipCode(c.chipType),
          chipName: chipName(c.chipType),
        };
        if (c.chipType === "C") {
          const target = c.challengedTeamId ? targetNameById.get(c.challengedTeamId) : undefined;
          if (target) entry.challengedTeamName = target;
          const match = challenges.get(c.id);
          if (match) entry.challenge = match;
        }
        (chipsByGameweek[gw.number] ??= {})[c.teamId] = entry;
      }
    }

    const responseData = {
      totalFixtures: allFixtures.length,
      fixtures: fixturesByGameweek,
      playoffStartGw,
      format,
      chipsByGameweek,
    };

    // Fire-and-forget cache write
    if (leagueId && !gameweekParam && !groupParam) {
      setCachedFixtures(leagueId, responseData).catch(() => {});
    }

    return NextResponse.json(responseData);
  } catch (error) {
    console.error("Error fetching fixtures:", error);
    // Return empty fixtures instead of error — likely no fixtures generated yet
    return NextResponse.json({
      fixtures: {},
      playoffStartGw: 31,
    });
  }
}
