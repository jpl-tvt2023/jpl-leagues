"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { StandingsTable } from "@/components/StandingsTable";
import { LoadingScreen } from "@/components/LoadingScreen";
import { LiveFreshness } from "@/components/LiveFreshness";
import { useLeague } from "@/lib/league-context";
import type { TeamStanding } from "@/types/standings";

/**
 * Same cadence as the fixtures tab. The two screens describe the same gameweek, so polling them
 * at different rates is how they come to disagree in front of a user.
 */
const LIVE_POLL_MS = 3 * 60 * 1000;

type SettledView = {
  groupA: TeamStanding[];
  groupB: TeamStanding[];
  /** The last processed gameweek — what this table is "as of". */
  gameweek: number;
};

export function ClassicStandings() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const { league, viewer } = useLeague();
  const leagueName = league.name;
  const leagueFormat = league.format;
  const isLoggedIn = viewer.authenticated;
  const dashboardHref = viewer.dashboardHref;

  const [liveGroupA, setLiveGroupA] = useState<TeamStanding[]>([]);
  const [liveGroupB, setLiveGroupB] = useState<TeamStanding[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teamSize, setTeamSize] = useState<number>(league.teamSize);
  const [groupsRevealed, setGroupsRevealed] = useState<boolean>(false);
  const [leagueStageEnd, setLeagueStageEnd] = useState<number>(0);
  const [isLive, setIsLive] = useState(false);
  const [liveGameweek, setLiveGameweek] = useState<number | null>(null);
  const [liveCachedAt, setLiveCachedAt] = useState<string | null>(null);

  /**
   * The table as it stood before the in-flight gameweek. The API sends it only while the
   * main table is provisional, so its presence is exactly the condition for offering the
   * toggle — there is nothing to switch to once the gameweek has been processed.
   */
  const [settledView, setSettledView] = useState<SettledView | null>(null);
  const [view, setView] = useState<"live" | "settled">("live");

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  useEffect(() => {
    if (!leagueSlug) return;
    let cancelled = false;

    const fetchStandings = async () => {
      try {
        const response = await fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (!response.ok) throw new Error("Failed to fetch standings");
        const data = await response.json();
        // A poll that lands after the user has navigated away must not write into a dead tree.
        if (cancelled) return;
        setLiveGroupA(data.groupA || []);
        setLiveGroupB(data.groupB || []);
        if (data.teamSize) setTeamSize(data.teamSize);
        setGroupsRevealed(data.groupsRevealed === true);
        setIsLive(data.isLive === true);
        setLiveGameweek(typeof data.liveGameweek === "number" ? data.liveGameweek : null);
        setLiveCachedAt(typeof data.liveCachedAt === "string" ? data.liveCachedAt : null);
        const stageEnd: number = data.leagueStageEnd ?? 30;
        setLeagueStageEnd(stageEnd);

        // A poll can land the moment the gameweek is processed, which retires the settled
        // view mid-session. Drop back to the live table rather than stranding the reader on
        // a table the server no longer has anything to say about.
        const settled = data.settled ?? null;
        setSettledView(settled);
        if (!settled) setView("live");
      } catch (err) {
        if (cancelled) return;
        console.error("Error fetching standings:", err);
        setError("Failed to load standings. Please try again later.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchStandings();
    // Poll unconditionally rather than only once a gameweek is live: the whole point is to pick
    // up the moment one starts, and by then the first response has long since been rendered.
    const id = setInterval(fetchStandings, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [leagueSlug]);

  // Which of the two tables is on screen. `settledView` going away (gameweek processed)
  // collapses this to the live table on its own, so no stale branch can render.
  const showingSettled = view === "settled" && settledView != null;
  const groupA = showingSettled ? settledView.groupA : liveGroupA;
  const groupB = showingSettled ? settledView.groupB : liveGroupB;

  const totalTeams = groupA.length + groupB.length;
  const isContinentalChampionship = leagueFormat === "continental-championship";

  // Derived from whichever table is displayed, so the settled view's header falls back a
  // gameweek on its own. Clamped to the stage end, as the header and the zone wording both
  // read it as "the last league-stage gameweek played".
  const latestGameweek = useMemo(() => {
    const maxPlayed = Math.max(
      ...groupA.map((t) => t.played),
      ...groupB.map((t) => t.played),
      0
    );
    return leagueStageEnd > 0 ? Math.min(maxPlayed, leagueStageEnd) : maxPlayed;
  }, [groupA, groupB, leagueStageEnd]);

  // `latestGameweek` is already clamped to the stage end, so this flips exactly when the
  // final league-stage gameweek has been played.
  const leagueStageComplete = leagueStageEnd > 0 && latestGameweek >= leagueStageEnd;

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#38003c] via-[#1a0021] to-[#0d001a]">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueName}
        currentPage="standings"
        format={isContinentalChampionship ? "continental-championship" : "tvt"}
        teamSize={teamSize}
        isLoggedIn={isLoggedIn}
        dashboardHref={dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        {isLoading ? (
          <LoadingScreen variant="standings" fullScreen={false} />
        ) : (
          <>
            <div className="text-center mb-8 sm:mb-12">
              <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">
                {isContinentalChampionship ? leagueName || "League" : "League Standings"}
              </h1>
              {isContinentalChampionship && (
                <p className="text-[#00ff85] text-sm font-semibold uppercase tracking-widest mb-2">
                  JPL · {league.season} Season
                </p>
              )}
              {!isContinentalChampionship && (
                <p className="text-gray-400">
                  {isLive && !showingSettled && liveGameweek != null
                    ? `Gameweek ${liveGameweek} in progress · League Stage`
                    : latestGameweek > 0
                      ? `After Gameweek ${latestGameweek} · League Stage`
                      : totalTeams > 0
                        ? "League Stage · No matches played yet"
                        : "League Stage · Awaiting teams"
                  }
                </p>
              )}
              {isLive && !showingSettled && (
                <div className="mt-3 flex flex-col items-center gap-1.5">
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-red-300"
                      data-testid="standings-live-badge"
                    >
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />
                      Live
                    </span>
                    <LiveFreshness updatedAt={liveCachedAt} isRefreshing={false} />
                  </div>
                  {/* Loud on purpose. This is the only thing telling the reader the table
                      below is not the real one, and as fine print it went unread. */}
                  <p className="mt-1 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-left text-xs sm:text-sm text-amber-200">
                    <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                      />
                    </svg>
                    Provisional table — includes in-progress fixtures, and settles when the gameweek is processed.
                  </p>
                </div>
              )}
              {latestGameweek > 0 && (!isLive || showingSettled) && (
                <p className="text-[11px] text-gray-500 mt-2">▲/▼ shows league rank change vs previous GW</p>
              )}
            </div>

            {/* Only offered while the main table is provisional: the settled table is what
                the standings were before the in-flight gameweek started moving them. Both
                tables arrive in the same response, so switching costs no round trip. */}
            {isLive && settledView != null && (
              <div className="mx-auto mb-6 flex w-fit gap-1 rounded-lg bg-slate-800/50 p-1">
                <button
                  onClick={() => setView("live")}
                  className={`rounded-md px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold transition ${
                    !showingSettled ? "bg-yellow-500 text-slate-900" : "text-gray-400 hover:text-white"
                  }`}
                >
                  Live · GW{liveGameweek}
                </button>
                <button
                  onClick={() => setView("settled")}
                  className={`rounded-md px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold transition ${
                    showingSettled ? "bg-yellow-500 text-slate-900" : "text-gray-400 hover:text-white"
                  }`}
                >
                  After GW{settledView.gameweek}
                </button>
              </div>
            )}

            {!isContinentalChampionship && (
              <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 mb-6 sm:mb-8 text-xs sm:text-sm">
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-green-500"></span>
                  <span className="text-gray-400">Title Play-offs (1-{teamSize === 8 ? 4 : 8})</span>
                </div>
                {teamSize !== 8 && (
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-yellow-500"></span>
                    <span className="text-gray-400">Challenger Series (9-14)</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-red-500"></span>
                  {/* Worded by stage: during the league stage these teams are in the
                      elimination ZONE and can still climb out of it. Only once the
                      stage is complete are they actually eliminated. */}
                  <span className="text-gray-400">
                    {leagueStageComplete ? "Eliminated" : "Elimination Zone"} ({teamSize === 8 ? "5-8" : "15-16"})
                  </span>
                </div>
              </div>
            )}

            {error ? (
              <div className="text-center text-red-400 py-12">{error}</div>
            ) : totalTeams === 0 ? (
              <div className="text-center py-12">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
                  <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">No Teams Yet</h2>
                  <p className="text-sm sm:text-base text-gray-400">Standings will appear here once teams are registered and matches are played.</p>
                </div>
              </div>
            ) : latestGameweek === 0 && totalTeams > 0 ? (
              <div className="text-center py-12">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
                  <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">Standings Coming Soon</h2>
                  <p className="text-gray-400 mb-4">Standings will be updated once:</p>
                  <ul className="text-gray-400 text-sm space-y-2">
                    <li>✓ {teamSize === 32 ? "Admin assigns teams to groups" : "Teams are registered"}</li>
                    <li>✓ Admin generates fixtures</li>
                    <li>✓ Matches are played</li>
                  </ul>
                </div>
              </div>
            ) : !groupsRevealed && groupB.length > 0 ? (
              <div className="max-w-3xl mx-auto">
                <div className="mb-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-center">
                  <p className="text-yellow-300 text-sm font-semibold">Groups have not been revealed yet</p>
                  <p className="text-yellow-400/70 text-xs mt-1">Group assignments will be announced by the admin before the season starts.</p>
                </div>
                <StandingsTable teams={[...groupA, ...groupB]} group={undefined} isContinentalChampionship={isContinentalChampionship} />
              </div>
            ) : (
              <div className={`grid gap-6 sm:gap-8 ${groupB.length > 0 ? "lg:grid-cols-2" : "max-w-2xl mx-auto"}`}>
                <StandingsTable teams={groupA} group={groupB.length > 0 ? "A" : undefined} isContinentalChampionship={isContinentalChampionship} />
                {groupB.length > 0 && <StandingsTable teams={groupB} group="B" isContinentalChampionship={isContinentalChampionship} />}
              </div>
            )}

            <div className="mt-6 sm:mt-8 text-center text-xs sm:text-sm text-gray-500 px-2">
              MP = Matches Played · W = Won · D = Drawn · L = Lost{!isContinentalChampionship && " · CP/BP = Chips & Bonus Points"} · Pts = League Points · Scores = Total FPL Score
            </div>
          </>
        )}
      </div>
    </div>
  );
}
