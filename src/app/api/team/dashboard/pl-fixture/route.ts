import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teams, fixtures, gameweeks, leagues, gameweekChips } from "@/lib/db/schema";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { fplEntryUrl } from "@/lib/fpl-links";
import { fetchTeamHistory } from "@/lib/fpl";
import {
  getCachedEntryHistories,
  setCachedEntryHistory,
  CACHE_TTL,
  LIVE_CACHE_TTL,
  getLiveCachedScores,
  isLiveCacheFresh,
  type LiveFixtureScore,
} from "@/lib/fpl-cache";
import { computeLiveFixtureScores } from "@/lib/fpl-live/tvt-live-scores";
import { getInFlightGameweekNumber } from "@/lib/gameweeks/in-flight";
import { getFinishedGwNumbers } from "@/lib/gameweeks/finished-set";
import { mapWithConcurrency } from "@/lib/concurrency";
import { withFplBudget, FplUnavailableError } from "@/lib/fpl/gateway";
import { buildFplChipStatus, type FplChipStatus } from "@/lib/fpl-league/chips";
import { getChipSet } from "@/lib/formats/tvt/scoring";
import { chipsUsedInSet, type ChipUsageRow } from "@/lib/formats/tvt/chip-usage";
import { isChipDisclosable } from "@/lib/formats/tvt/chip-waste";
import { TVT_CHIP_CODES } from "@/lib/formats/tvt/chip-labels";

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
  tvtChips: {
    set: 1 | 2 | "playoffs";
    /** The chip codes this league runs — any three of D/W/C/SL/CB/UD. */
    enabled: string[];
    /** Which of those this side has spent in the set. */
    spent: string[];
    /**
     * Which gameweek each spent chip was played in, so the UI can distinguish a
     * chip burned weeks ago from one in play right now. Past deadlines only —
     * see the filter in loadTvtChipGameweeks.
     */
    usedGws: { code: string; gw: number }[];
  };
  playersLeft: { leftToPlay: number; total: number } | null;
}

export async function GET(request: NextRequest) {
  try {
    const teamId = request.headers.get("x-session-id");
    if (!teamId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });

    const leagueRow = await db
      .select({ id: leagues.id, slug: leagues.slug, playoffStartGw: leagues.playoffStartGw, enabledChips: leagues.enabledChips })
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
    // True when the numbers being returned are past their fresh window. The
    // card shows them at once and asks for a refresh behind them, rather than
    // making the reader wait on a sweep — same bargain as the fixtures page.
    let liveIsStale = false;
    /** When these numbers were computed, so the card can show their age. */
    let liveCachedAt: string | null = null;
    const wantsRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    if (isLive) {
      const cached = wantsRefresh ? null : await getLiveCachedScores(gw, league.id);
      live = cached?.fixtures.find((f) => f.fixtureId === fixtureRow.id) ?? null;
      if (live) {
        liveIsStale = !isLiveCacheFresh(cached);
        liveCachedAt = cached?.cachedAt ?? null;
      }
      if (!live) {
        try {
          const computed = await withFplBudget(
            // One fixture costs 4 picks plus the shared fixtures and bootstrap
            // lookups: six on a cold cache. The old ceiling of 8 sat close enough
            // that a single duplicated lookup pushed it over, and a budget refusal
            // surfaces as a silently missing players-left count rather than an
            // error. Headroom, not a licence to fan out.
            { lane: "background", label: `pl-fixture gw${gw}`, max: 12 },
            () =>
              computeLiveFixtureScores({
                leagueId: league.id,
                gwNumber: gw,
                fixtureIds: [fixtureRow.id],
              })
          );
          live = computed[0] ?? null;
          if (live) liveCachedAt = new Date().toISOString();
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

    // ── Which gameweek each TVT chip was played in ────────────────────────
    //
    // ⚠️ Past deadlines ONLY, and this filter is load-bearing. A gameweek_chips
    // row is written when a chip is DECLARED, which can be well before that
    // gameweek's deadline — and this payload goes to both teams in the fixture.
    // Including a pending row would let a team see their opponent's Double
    // Pointer before choosing their own captain: precisely the leak that the
    // used/available booleans below were introduced to prevent.
    const chipRows = await db
      .select({
        teamId: gameweekChips.teamId,
        chipType: gameweekChips.chipType,
        gameweekId: gameweekChips.gameweekId,
        isValid: gameweekChips.isValid,
        isProcessed: gameweekChips.isProcessed,
        hadNegativeHits: gameweekChips.hadNegativeHits,
        wastedReason: gameweekChips.wastedReason,
      })
      .from(gameweekChips)
      .where(inArray(gameweekChips.teamId, [fixtureRow.homeTeamId, fixtureRow.awayTeamId]));

    const usedGwsByTeam = new Map<string, { code: string; gw: number }[]>();
    const usageRowsByTeam = new Map<string, ChipUsageRow[]>();
    for (const row of chipRows) {
      const chipGw = gwById.get(row.gameweekId);
      if (!chipGw || chipGw.deadline > now) continue; // not public yet
      if (!isChipDisclosable(row)) continue; // rejected declaration, never played
      const list = usedGwsByTeam.get(row.teamId) ?? [];
      list.push({ code: TVT_CHIP_CODES[row.chipType] ?? row.chipType, gw: chipGw.number });
      usedGwsByTeam.set(row.teamId, list);
      const usage = usageRowsByTeam.get(row.teamId) ?? [];
      usage.push({
        chipType: row.chipType,
        gameweekNumber: chipGw.number,
        isValid: row.isValid,
        isProcessed: row.isProcessed,
      });
      usageRowsByTeam.set(row.teamId, usage);
    }
    for (const list of usedGwsByTeam.values()) list.sort((a, b) => a.gw - b.gw);

    const chipSet = getChipSet(gw, league.playoffStartGw ?? 31);
    let leagueEnabledChips: string[] = ["D", "W", "C"];
    try {
      leagueEnabledChips = JSON.parse(league.enabledChips ?? '["D","W","C"]');
    } catch {
      /* keep default on malformed JSON */
    }

    const usedFor = (teamRowId: string) =>
      chipsUsedInSet(usageRowsByTeam.get(teamRowId) ?? [], chipSet, league.playoffStartGw ?? 31);

    const buildSide = (
      t: { id: string; name: string; players: { name: string; fplId: string }[] },
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
        // Codes this league runs, and which of them this side has spent in the set. Was
        // three fixed D/C/W booleans, which said nothing about an SL/CB/UD league.
        enabled: leagueEnabledChips,
        spent: leagueEnabledChips.filter((code) => usedFor(t.id).has(code)),
        usedGws: usedGwsByTeam.get(t.id) ?? [],
      },
      playersLeft,
    });


    return NextResponse.json({
      gw,
      availableGws,
      defaultGw,
      linkGw,
      isLive,
      stale: liveIsStale,
      liveCachedAt,
      isHome: fixtureRow.homeTeamId === teamId,
      fixture: {
        id: fixtureRow.id,
        home: buildSide(fixtureRow.homeTeam, live?.homePlayersLeft ?? null),
        away: buildSide(fixtureRow.awayTeam, live?.awayPlayersLeft ?? null),
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
