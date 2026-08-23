"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useLeague } from "@/lib/league-context";
import { fplEntryUrl } from "@/lib/fpl-links";
import { FplChipRow } from "@/components/ChipPill";
import { type FplChipStatus } from "@/lib/fpl-league/chips";

interface Row {
  rank: number;
  teamId: string;
  teamName: string;
  playerName: string;
  fplId: string;
  gwPoints: number | null;
  gwTransferCost: number;
  totalPoints: number;
  chips: FplChipStatus;
  pending?: true;
}

interface Payload {
  rows: Row[];
  gw: number | null;
  isLive: boolean;
  warming: number;
  /** False when the server has no cache, so polling cannot make progress. */
  cacheEnabled: boolean;
  cachedAt: string;
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
            Tap a row to open that manager&rsquo;s page on the FPL site.
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

            <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="border-b border-purple-500/20 bg-purple-900/30 text-[10px] sm:text-xs text-gray-300">
                      <th className="px-2 py-2 sm:px-3 text-left font-medium w-10">#</th>
                      <th className="px-2 py-2 sm:px-3 text-left font-medium">Player</th>
                      <th className="px-2 py-2 sm:px-3 text-left font-medium hidden sm:table-cell">
                        Team
                      </th>
                      <th className="px-1.5 py-2 sm:px-2 text-center font-medium w-20">
                        {data.gw ? `GW${data.gw}` : "GW"} Pts
                        {data.isLive && (
                          <span className="ml-1 inline-flex items-center gap-1 text-green-400">
                            <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                            LIVE
                          </span>
                        )}
                      </th>
                      <th className="px-1.5 py-2 sm:px-2 text-center font-medium w-16">Total</th>
                      <th className="px-2 py-2 sm:px-3 text-left font-medium">FPL Chips</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr
                        key={`${row.teamId}-${row.fplId}`}
                        className={`border-b border-white/5 transition ${
                          row.pending ? "opacity-60" : "hover:bg-white/5 cursor-pointer"
                        }`}
                        onClick={
                          row.pending
                            ? undefined
                            : () =>
                                window.open(
                                  fplEntryUrl(row.fplId, data.gw),
                                  "_blank",
                                  "noopener,noreferrer"
                                )
                        }
                      >
                        <td className="px-2 py-2 sm:px-3 text-gray-400 font-medium">{row.rank}</td>
                        <td className="px-2 py-2 sm:px-3">
                          {/* A real anchor as well as the row click, so keyboard
                              and middle-click both work. */}
                          <a
                            href={fplEntryUrl(row.fplId, data.gw)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-white hover:text-blue-300 transition"
                          >
                            {row.playerName}
                          </a>
                          <div className="text-[10px] text-gray-500 sm:hidden truncate">
                            {row.teamName}
                          </div>
                        </td>
                        <td className="px-2 py-2 sm:px-3 text-gray-300 hidden sm:table-cell truncate">
                          {row.teamName}
                        </td>
                        <td className="px-1.5 py-2 sm:px-2 text-center text-white">
                          {row.gwPoints == null ? (
                            <span className="text-gray-600">—</span>
                          ) : (
                            <>
                              {row.gwPoints}
                              {row.gwTransferCost > 0 && (
                                <span className="text-red-400 text-[10px]">
                                  {" "}
                                  (−{row.gwTransferCost})
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-1.5 py-2 sm:px-2 text-center font-bold text-white">
                          {row.pending ? <span className="text-gray-600">—</span> : row.totalPoints}
                        </td>
                        <td className="px-2 py-2 sm:px-3">
                          <div className="flex flex-wrap gap-1">
                            {/* Coloured against the gameweek this table is showing, so a
                                chip being played right now reads differently from one
                                spent weeks ago. */}
                            <FplChipRow status={row.chips} gwNumber={data.gw} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="mt-4 text-[10px] sm:text-xs text-gray-500">
              Totals come straight from the official FPL API. Gameweek points show the gameweek in
              progress while one is live, otherwise the most recently completed one.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
