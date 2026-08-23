import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teams, fixtures, gameweeks, leagues } from "@/lib/db/schema";
import { and, asc, eq, or } from "drizzle-orm";
import { fplEntryUrl } from "@/lib/fpl-links";
import { fetchTeamHistory } from "@/lib/fpl";
import {
  getCachedEntryHistories,
  setCachedEntryHistory,
  CACHE_TTL,
  LIVE_CACHE_TTL,
  getLiveCachedScores,
  type LiveFixtureScore,
} from "@/lib/fpl-cache";
import { computeLiveFixtureScores } from "@/lib/fpl-live/tvt-live-scores";
import { getInFlightGameweekNumber } from "@/lib/gameweeks/in-flight";
import { getFinishedGwNumbers } from "@/lib/gameweeks/finished-set";
import { mapWithConcurrency } from "@/lib/concurrency";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";
import { buildFplChipStatus, type FplChipStatus } from "@/lib/fpl-league/chips";
import { getChipSet } from "@/lib/formats/tvt/scoring";

/**
 * GET /api/team/dashboard/pl-fixture[?gw=N][&refresh=1]
 *
 * Everything the dashboard's PL Fixture card needs for one gameweek: the
 * team's fixture, live or stored scores, both sides' chip state, and how many
 * players each side still has to feature.
 *
 * Sits under /api/team/ so middleware applies team auth automatically.
 *
 * Scoped to one fixture on purpose. The fixtures page computes a whole
 * gameweek; here that would be ~16x the FPL calls for 15 fixtures nobody is
 * looking at.
 */

export const maxDuration = 60;

interface SideInfo {
  teamId: string;
  name: string;
  players: { name: string; fplId: string; fplUrl: string; fplChips: FplChipStatus | null }[];
  tvtChips: { set: 1 | 2 | "playoffs"; doublePointer: boolean; challengeChip: boolean; winWin: boolean };
  playersLeft: { leftToPlay: number; total: number } | null;
}

export async function GET(request: NextRequest) {
  try {
    const teamId = request.headers.get("x-session-id");
    if (!teamId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });

    const leagueRow = await db
      .select({ id: leagues.id, slug: leagues.slug, playoffStartGw: leagues.playoffStartGw })
      .from(leagues)
      .where(eq(leagues.id, team.leagueId))
      .limit(1);
    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }
    const league = leagueRow[0];

    const leagueGws = await db
      .select({ id: gameweeks.id, number: gameweeks.number, deadline: gameweeks.deadline })
      .from(gameweeks)
      .where(eq(gameweeks.leagueId, league.id))
      .orderBy(asc(gameweeks.number));

    const now = new Date();

    // Links must point at the latest gameweek that has actually STARTED —
    // FPL only resolves /entry/{id}/event/{n} once GW n's deadline has passed.
    // So while GW1 is being played and you page forward to view GW2, the links
    // still (correctly) point at GW1.
    const started = leagueGws.filter((g) => g.deadline <= now).map((g) => g.number);
    const linkGw = started.length > 0 ? Math.max(...started) : null;

    // Every gameweek this team actually plays in.
    const myFixtures = await db
      .select({
        id: fixtures.id,
        gameweekId: fixtures.gameweekId,
        homeTeamId: fixtures.homeTeamId,
        awayTeamId: fixtures.awayTeamId,
      })
      .from(fixtures)
      .where(or(eq(fixtures.homeTeamId, teamId), eq(fixtures.awayTeamId, teamId)));

    const gwById = new Map(leagueGws.map((g) => [g.id, g]));
    const availableGws = [
      ...new Set(myFixtures.map((f) => gwById.get(f.gameweekId)?.number).filter((n): n is number => !!n)),
    ].sort((a, b) => a - b);

    // Default: the gameweek in flight, else the next one still to come.
    // getInFlightGameweekNumber is exactly "deadline passed but we have no
    // result yet", which is the card's "currently being played" notion.
    const inFlight = await getInFlightGameweekNumber(league.id);
    const upcoming = leagueGws.find((g) => g.deadline > now)?.number ?? null;
    const finishedSet = await getFinishedGwNumbers();
    const defaultGw =
      inFlight ?? upcoming ?? (availableGws.length > 0 ? availableGws[availableGws.length - 1] : null);

    const requested = Number(request.nextUrl.searchParams.get("gw"));
    const gw =
      Number.isFinite(requested) && availableGws.includes(requested) ? requested : defaultGw;

    if (gw == null) {
      return NextResponse.json({
        gw: null, availableGws, defaultGw, linkGw, isLive: false,
        fixture: null, live: null, result: null,
      });
    }

    const gwRow = leagueGws.find((g) => g.number === gw)!;
    const isLive = inFlight === gw && !(finishedSet?.has(gw) ?? false);

    const fixtureRow = await db.query.fixtures.findFirst({
      where: and(
        eq(fixtures.gameweekId, gwRow.id),
        or(eq(fixtures.homeTeamId, teamId), eq(fixtures.awayTeamId, teamId))
      ),
      with: {
        homeTeam: { with: { players: true } },
        awayTeam: { with: { players: true } },
        result: true,
      },
    });

    if (!fixtureRow) {
      return NextResponse.json({
        gw, availableGws, defaultGw, linkGw, isLive,
        fixture: null, live: null, result: null,
      });
    }

    // ── Live scores for this one fixture ──────────────────────────────────
    let live: LiveFixtureScore | null = null;
    const wantsRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    if (isLive) {
      const cached = wantsRefresh ? null : await getLiveCachedScores(gw, league.id);
      live = cached?.fixtures.find((f) => f.fixtureId === fixtureRow.id) ?? null;
      if (!live) {
        try {
          const computed = await withFplBudget(
            { lane: "background", label: `pl-fixture gw${gw}`, max: 8 },
            () =>
              computeLiveFixtureScores({
                leagueId: league.id,
                gwNumber: gw,
                fixtureIds: [fixtureRow.id],
              })
          );
          live = computed[0] ?? null;
        } catch (err) {
          if (!(err instanceof FplUnavailableError)) throw err;
          // Breaker open or scoring in progress — fall back to stored data.
        }
      }
    }

    // ── FPL chip status for all four managers ─────────────────────────────
    const allPlayers = [...fixtureRow.homeTeam.players, ...fixtureRow.awayTeam.players];
    const fplIds = [...new Set(allPlayers.map((p) => p.fplId))];
    const histories = await getCachedEntryHistories(fplIds);
    const missing = fplIds.filter((id) => !histories.has(id));
    if (missing.length > 0) {
      try {
        await withFplBudget(
          { lane: "background", label: "pl-fixture chips", max: 4 },
          () =>
            mapWithConcurrency(missing.slice(0, 4), 2, async (fplId) => {
              try {
                const history = await fetchTeamHistory(fplId);
                await setCachedEntryHistory(fplId, history, isLive ? LIVE_CACHE_TTL : CACHE_TTL);
                histories.set(fplId, { ...history, cachedAt: new Date().toISOString() });
              } catch {
                // Chip badges are decoration — never fail the card over them.
              }
            })
        );
      } catch (err) {
        if (!(err instanceof FplUnavailableError)) throw err;
      }
    }

    const chipSet = getChipSet(gw, league.playoffStartGw ?? 31);

    const buildSide = (
      t: { id: string; name: string; players: { name: string; fplId: string }[] },
      row: typeof team,
      playersLeft: { leftToPlay: number; total: number } | null
    ): SideInfo => ({
      teamId: t.id,
      name: t.name,
      players: t.players.map((p) => ({
        name: p.name,
        fplId: p.fplId,
        fplUrl: fplEntryUrl(p.fplId, linkGw),
        fplChips: histories.has(p.fplId) ? buildFplChipStatus(histories.get(p.fplId)!.chips) : null,
      })),
      // Only used/available — never a pending declaration. Chip rows exist
      // before a deadline, and surfacing the opponent's would let a team see
      // their Double Pointer before choosing their own captain.
      tvtChips: {
        set: chipSet,
        doublePointer: chipSet === 1 ? row.doublePointerSet1Used : chipSet === 2 ? row.doublePointerSet2Used : false,
        challengeChip: chipSet === 1 ? row.challengeChipSet1Used : chipSet === 2 ? row.challengeChipSet2Used : false,
        winWin: chipSet === 1 ? row.winWinSet1Used : chipSet === 2 ? row.winWinSet2Used : false,
      },
      playersLeft,
    });

    const [homeTeamRow, awayTeamRow] = await Promise.all([
      db.query.teams.findFirst({ where: eq(teams.id, fixtureRow.homeTeamId) }),
      db.query.teams.findFirst({ where: eq(teams.id, fixtureRow.awayTeamId) }),
    ]);

    return NextResponse.json({
      gw,
      availableGws,
      defaultGw,
      linkGw,
      isLive,
      isHome: fixtureRow.homeTeamId === teamId,
      fixture: {
        id: fixtureRow.id,
        home: buildSide(fixtureRow.homeTeam, homeTeamRow!, live?.homePlayersLeft ?? null),
        away: buildSide(fixtureRow.awayTeam, awayTeamRow!, live?.awayPlayersLeft ?? null),
      },
      live,
      result: fixtureRow.result
        ? {
            homeScore: fixtureRow.result.homeScore,
            awayScore: fixtureRow.result.awayScore,
            homePlayerScores: fixtureRow.result.homePlayerScores,
            awayPlayerScores: fixtureRow.result.awayPlayerScores,
          }
        : null,
    });
  } catch (error) {
    console.error("PL fixture card error:", error);
    return NextResponse.json({ error: "Failed to load fixture" }, { status: 500 });
  }
}
