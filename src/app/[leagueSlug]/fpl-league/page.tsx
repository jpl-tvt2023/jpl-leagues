"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useLeague, useEnforceFormat } from "@/lib/league-context";
import { FplLeagueTable, type ManagerRowData } from "./_components/FplLeagueTable";
import type { FplLeagueTeam } from "@/lib/fpl-league/team-stats";

interface Payload {
  rows: ManagerRowData[];
  gw: number | null;
  isLive: boolean;
  warming: number;
  /** False when the server has no cache, so polling cannot make progress. */
  cacheEnabled: boolean;
  cachedAt: string;
  /* Team-level stats. Sent on every response — including warm polls, which replace this
     payload wholesale — so the team rows never blank out mid-warm. */
  teams: FplLeagueTeam[];
  groupNames: string[];
  hasHiddenGroups: boolean;
  currentSet: 1 | 2 | "playoffs" | null;
}

/** How often to re-ask while the table is still filling in. */
const WARM_POLL_MS = 4000;

/**
 * Consecutive polls allowed to make no progress before giving up.
 *
 * Not every poll can progress: the server holds a ~10s single-flight claim so
 * simultaneous visitors do not each warm their own batch, which at a 4s poll
 * means roughly two in three polls are legitimately no-ops. Giving up on the
 * first flat result would abandon a table that was still converging.
 */
const MAX_STALLED_POLLS = 4;

/**
 * Absolute backstop, so a permanently stuck warm cannot poll forever. Sized
 * to comfortably cover a cold 64-manager league (6 warm rounds of 12).
 */
const MAX_TOTAL_POLLS = 30;

export default function FplLeaguePage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;
  const { league, viewer } = useLeague();
  // Every format EXCEPT fpl-classic, which has none of this page's underlying data (no teams,
  // no fixtures, no playoff bracket). Listing the three explicitly rather than excluding one
  // keeps the existing formats' behaviour byte-identical.
  useEnforceFormat(["tvt", "continental-championship", "auction"]);


  const [data, setData] = useState<Payload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/fpl-league?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (!res.ok) throw new Error("Failed to fetch FPL standings");
        const body = (await res.json()) as Payload;
        if (cancelled) return;
        setData(body);
        setError(null);
      } catch {
        if (!cancelled) setError("Failed to load FPL standings. Please try again later.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [leagueSlug]);

  // A cold league warms a few managers per request, so poll while rows are
  // still filling in. Stops as soon as everything has data.
  //
  // Keyed on PROGRESS rather than a fixed number of attempts: how many rounds
  // a league needs depends on its size, so any fixed cap is either too small
  // for a 64-manager league or pointlessly patient on a stuck one. Polling
  // continues while `warming` keeps falling and stops once it plateaus.
  //
  // The server reports warming: 0 when it has no cache at all, so this never
  // starts in an environment where re-asking cannot possibly help.
  const pollsRef = useRef(0);
  const stalledRef = useRef(0);
  const bestRef = useRef(Number.POSITIVE_INFINITY);

  useEffect(() => {
    if (!data || data.warming === 0) return;

    if (data.warming < bestRef.current) {
      bestRef.current = data.warming;
      stalledRef.current = 0;
    }
    if (stalledRef.current >= MAX_STALLED_POLLS) return;
    if (pollsRef.current >= MAX_TOTAL_POLLS) return;

    // The first pass goes out immediately: the table is already on screen, so
    // there is nothing to wait for. Later passes are spaced, since they only
    // exist for the case where one pass did not finish the job.
    const delay = pollsRef.current === 0 ? 0 : WARM_POLL_MS;

    const id = setTimeout(async () => {
      pollsRef.current += 1;
      stalledRef.current += 1; // reset above if this poll turns out to help
      try {
        // warm=1: this is the request that actually fetches from FPL. The
        // initial load deliberately does not, so first paint is instant.
        const res = await fetch(
          `/api/fpl-league?leagueSlug=${encodeURIComponent(leagueSlug)}&warm=1`,
        );
        if (res.ok) setData(await res.json());
      } catch {
        // A failed poll should never disturb the table already on screen.
      }
    }, delay);
    return () => clearTimeout(id);
  }, [data, leagueSlug]);

  // A different league means a fresh warm budget.
  useEffect(() => {
    pollsRef.current = 0;
    stalledRef.current = 0;
    bestRef.current = Number.POSITIVE_INFINITY;
  }, [leagueSlug]);

  // Split into per-group tables when the league has more than one revealed group. Teams and
  // their manager rows are partitioned together so each table is self-contained.
  //
  // Ranks stay LEAGUE-WIDE: this page ranks by official FPL season total across everyone, so
  // Group B's first row can read #3. Renumbering per group would contradict the page's whole
  // premise (and the ordering the API pins).
  const groupTables = (() => {
    if (!data || data.groupNames.length < 2) return [];
    return data.groupNames.map((label) => {
      const teams = data.teams.filter((t) => t.group === label);
      const ids = new Set(teams.map((t) => t.teamId));
      return { label, teams, rows: data.rows.filter((r) => ids.has(r.teamId)) };
    });
  })();

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="fpl-league"
        // league.format is typed as string in the context; narrow it the same
        // way ClassicStandings does. This page is TVT-only in the nav anyway.
        format={league.format === "continental-championship" ? "continental-championship" : "tvt"}
        teamSize={league.teamSize}
        isLoggedIn={viewer.authenticated}
        dashboardHref={viewer.dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="mb-6 sm:mb-8">
          <h1 className="text-2xl sm:text-4xl font-bold text-white">FPL League</h1>
          <p className="mt-2 text-sm sm:text-base text-gray-400">
            Every manager in the league, ranked by their official Fantasy Premier League season
            total — individual standings rather than team-vs-team.
          </p>
          <p className="mt-1 text-xs text-gray-500">
            Tap a manager to open their page on the FPL site.
            {(data?.teams.length ?? 0) > 0 && (
              <> Ranks are league-wide, so a group table may not start at #1.</>
            )}
          </p>
        </div>

        {isLoading ? (
          <LoadingScreen variant="standings" fullScreen={false} />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : !data || data.rows.length === 0 ? (
          <div className="text-center py-12">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
              <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">No Managers Yet</h2>
              <p className="text-sm sm:text-base text-gray-400">
                Standings appear here once teams have completed setup with their FPL IDs.
              </p>
            </div>
          </div>
        ) : (
          <>
            {data.warming > 0 ? (
              <div className="mb-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 text-xs">
                Loading {data.warming} more {data.warming === 1 ? "manager" : "managers"} from FPL —
                this page fills in over a few seconds the first time it is opened.
              </div>
            ) : (
              /* No cache configured: the server warms a fixed batch per request
                 and nothing carries over, so the remaining rows will not fill
                 in no matter how long you wait. Say so, rather than showing a
                 "loading" note that never resolves. */
              !data.cacheEnabled &&
              data.rows.some((r) => r.pending) && (
                <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs">
                  Showing partial standings — FPL caching is not configured in this
                  environment, so only some managers could be loaded.
                </div>
              )
            )}

            {data.hasHiddenGroups && (
              <div className="mb-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-center">
                <p className="text-yellow-300 text-sm font-semibold">
                  Groups have not been revealed yet
                </p>
                <p className="text-yellow-400/70 text-xs mt-1">
                  Group assignments will be announced by the admin before the season starts.
                </p>
              </div>
            )}

            {groupTables.length > 1 ? (
              <div className="grid gap-6 sm:gap-8 lg:grid-cols-2">
                {groupTables.map(({ label, teams, rows }) => (
                  <FplLeagueTable
                    key={label}
                    groupLabel={label}
                    compact
                    teams={teams}
                    rows={rows}
                    gw={data.gw}
                    isLive={data.isLive}
                    currentSet={data.currentSet}
                  />
                ))}
              </div>
            ) : (
              <FplLeagueTable
                teams={data.teams}
                rows={data.rows}
                gw={data.gw}
                isLive={data.isLive}
                currentSet={data.currentSet}
              />
            )}

            <p className="mt-4 text-[10px] sm:text-xs text-gray-500">
              Totals come straight from the official FPL API. Gameweek points show the gameweek in
              progress while one is live, otherwise the most recently completed one.
              {data.teams.length > 0 && (
                <>
                  {" "}
                  Team rows carry this league&rsquo;s own TVT chips (DP/WW/CC) per set and each
                  manager&rsquo;s captaincies used; the FPL Chips column is the official FPL ones.
                  Both appear only once their gameweek deadline has passed, so a team&rsquo;s own
                  dashboard may show a pick this page does not yet.
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
