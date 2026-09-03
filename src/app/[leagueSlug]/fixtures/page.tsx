"use client";

import { GwNavigator } from "@/components/GwNavigator";
import { LiveFreshness } from "@/components/LiveFreshness";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { LeagueNav } from "@/components/LeagueNav";
import { useLeague, useEnforceFormat } from "@/lib/league-context";
import { pickDefaultGameweek } from "@/lib/gameweeks/default-gw";
import {
  type Fixture,
  type GameweekFixtures,
  type LiveFixtureScore,
  type BreakdownChips,
  PlayerBreakdown,
} from "../_components/fixtures/shared";
import { ChallengeTip, type ChipDisplay } from "../_components/fixtures/ChallengeTip";
import {
  buildLiveChallengeMatch,
  indexLiveSides,
} from "@/lib/formats/tvt/challenge-match-live";
import type { ChallengeMatch } from "@/lib/formats/tvt/challenge-match";
import { tvtChipWasteReasonFor } from "@/lib/formats/tvt/fpl-chip-clash";
import type { FplChipStatus } from "@/lib/fpl-league/chips";

/** Chips played in a gameweek, keyed by gameweek number then team id. */
type ChipsByGameweek = Record<number, Record<string, ChipDisplay>>;
/** Each league team's managers, keyed by team id. */
type PlayersByTeamId = Record<string, { name: string; fplId: string }[]>;
/** FPL chip status for every manager whose history is cached, keyed by FPL entry id. */
type FplChipsByFplId = Record<string, FplChipStatus>;

/** In-progress challenge matches for the gameweek on screen, keyed by challenger team id. */
type LiveChallenges = Record<string, ChallengeMatch>;

function FixtureCard({
  fixture,
  liveData,
  isFreshlyRefreshed,
  homeChip,
  awayChip,
  homeLiveChallenge,
  awayLiveChallenge,
  playersByTeamId,
  fplChipsByFplId,
}: {
  fixture: Fixture;
  liveData?: LiveFixtureScore;
  isFreshlyRefreshed?: boolean;
  /** Chip that side played in THIS fixture's gameweek, if any. */
  homeChip?: ChipDisplay;
  awayChip?: ChipDisplay;
  /** That side's challenge as it stands right now, when the gameweek is still in flight. */
  homeLiveChallenge?: ChallengeMatch | null;
  awayLiveChallenge?: ChallengeMatch | null;
  playersByTeamId: PlayersByTeamId;
  fplChipsByFplId: FplChipsByFplId;
}) {
  const [expanded, setExpanded] = useState(false);
  const result = fixture.result;
  const isResult = result !== undefined && result !== null;
  const isLive = !isResult && !!liveData;

  const homePlayers = fixture.homeTeam.id ? playersByTeamId[fixture.homeTeam.id] ?? [] : [];
  const awayPlayers = fixture.awayTeam.id ? playersByTeamId[fixture.awayTeam.id] ?? [] : [];

  // FPL chip pills under each manager's name — cache-only data the page already fetched, so this
  // costs nothing extra. `silentWhenUnknown` because a cold cache is the ordinary state on this
  // public page, not a fault worth a placeholder.
  const homeBreakdownChips: BreakdownChips | undefined = homePlayers.length > 0 ? {
    byFplId: Object.fromEntries(homePlayers.map((p) => [p.fplId, fplChipsByFplId[p.fplId] ?? null])),
    tvt: [],
    tvtLabel: "",
    interactive: true,
    silentWhenUnknown: true,
  } : undefined;
  const awayBreakdownChips: BreakdownChips | undefined = awayPlayers.length > 0 ? {
    byFplId: Object.fromEntries(awayPlayers.map((p) => [p.fplId, fplChipsByFplId[p.fplId] ?? null])),
    tvt: [],
    tvtLabel: "",
    interactive: true,
    silentWhenUnknown: true,
  } : undefined;

  /**
   * "This TVT chip will be wasted" — a client-side prediction from FPL chip history, shown only
   * before the fixture is scored. Once `fixture.result` exists, the scorer's own verdict
   * (`chip.isWasted`) has already run for this gameweek and is used instead — see the guard in
   * ChallengeTip, which always prefers stored fact over a prediction.
   *
   * `isResult` is a reasonable proxy for "has chip processing run this gameweek": the scorer
   * processes every fixture and every chip — including the Challenge Chip's separate pass — in
   * one request, so a written result implies the chip rows for this gameweek were touched too.
   */
  const homePredictedWaste = !isResult && homeChip && !homeChip.isWasted
    ? tvtChipWasteReasonFor(
        homePlayers.map((p) => fplChipsByFplId[p.fplId] ?? null),
        fixture.gameweek.number,
        homeChip.chipName,
      )
    : null;
  const awayPredictedWaste = !isResult && awayChip && !awayChip.isWasted
    ? tvtChipWasteReasonFor(
        awayPlayers.map((p) => fplChipsByFplId[p.fplId] ?? null),
        fixture.gameweek.number,
        awayChip.chipName,
      )
    : null;

  const homeScore = isResult ? result.homeScore : liveData?.homeScore;
  const awayScore = isResult ? result.awayScore : liveData?.awayScore;
  const hasScore = homeScore !== undefined && awayScore !== undefined;

  const homeWin = hasScore && homeScore! > awayScore!;
  const awayWin = hasScore && awayScore! > homeScore!;
  const draw = hasScore && homeScore === awayScore;

  const homeScoreClass = isResult
    ? homeWin ? "text-green-400" : "text-gray-400"
    : isLive && isFreshlyRefreshed
      ? "text-amber-400 animate-pulse"
      : "text-white";

  const awayScoreClass = isResult
    ? awayWin ? "text-green-400" : "text-gray-400"
    : isLive && isFreshlyRefreshed
      ? "text-amber-400 animate-pulse"
      : "text-white";

  const hasPlayerData = (liveData?.homePlayers?.length ?? 0) > 0 || !!(fixture.result?.homePlayerScores) || isResult;

  return (
    <div
      data-testid={`fixture-card-${fixture.id}`}
      className={`rounded-xl border p-4 backdrop-blur transition ${
        isLive ? "border-green-500/30 bg-green-500/5" : "border-white/10 bg-white/5"
      } cursor-pointer`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex justify-end mb-2">
        {isResult && (
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded ${
              draw ? "bg-gray-500/20 text-gray-400" : "bg-green-500/20 text-green-400"
            }`}
          >
            {draw ? "Draw" : "Final"}
          </span>
        )}
        {isLive && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded flex items-center gap-1 ${
            isFreshlyRefreshed ? "bg-amber-500/20 text-amber-400" : "bg-white/10 text-gray-400"
          }`}>
            <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${
              isFreshlyRefreshed ? "bg-amber-400" : "bg-gray-400"
            }`}></span>
            LIVE
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0 text-left text-white">
          <div className="font-semibold text-xs sm:text-sm truncate">{fixture.homeTeam.name}</div>
          {homeChip && (
            <ChallengeTip
              chip={homeChip}
              liveChallenge={homeLiveChallenge}
              predictedWasteReason={homePredictedWaste}
              align="left"
              className="mt-0.5"
            />
          )}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 px-1 sm:px-3 shrink-0">
          {hasScore ? (
            <>
              <span className={`text-lg sm:text-xl font-bold ${homeScoreClass}`}>{homeScore}</span>
              <span className="text-gray-500">-</span>
              <span className={`text-lg sm:text-xl font-bold ${awayScoreClass}`}>{awayScore}</span>
            </>
          ) : (
            <span className="text-gray-500 font-medium text-xs sm:text-sm">VS</span>
          )}
        </div>

        <div className="flex-1 min-w-0 text-right text-white">
          <div className="font-semibold text-xs sm:text-sm truncate">{fixture.awayTeam.name}</div>
          {awayChip && (
            <ChallengeTip
              chip={awayChip}
              liveChallenge={awayLiveChallenge}
              predictedWasteReason={awayPredictedWaste}
              align="right"
              className="mt-0.5"
            />
          )}
        </div>
      </div>

      {isLive && (liveData?.homePlayersLeft !== undefined || liveData?.awayPlayersLeft !== undefined) && (
        <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500">
          <span className={liveData?.homePlayersLeft ? "text-emerald-400/80" : ""}>
            {liveData?.homePlayersLeft ? `⏳ ${liveData.homePlayersLeft.leftToPlay} left` : "—"}
          </span>
          <span className="text-gray-600">to play</span>
          <span className={liveData?.awayPlayersLeft ? "text-emerald-400/80" : ""}>
            {liveData?.awayPlayersLeft ? `⏳ ${liveData.awayPlayersLeft.leftToPlay} left` : "—"}
          </span>
        </div>
      )}

      <div className="mt-2">
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="w-full text-center text-[10px] text-gray-500 hover:text-gray-300 transition py-1"
        >
          {expanded ? "▲ Hide breakdown" : "▼ Player breakdown"}
        </button>
        {expanded && (
          hasPlayerData
            ? (
              <PlayerBreakdown
                fixture={fixture}
                liveData={liveData}
                homeChips={homeBreakdownChips}
                awayChips={awayBreakdownChips}
              />
            )
            : <div className="mt-2 p-3 rounded-lg bg-white/5 border border-white/10 text-center text-xs text-gray-400">
                Player breakdown not yet available — FPL data will appear once the gameweek begins.
              </div>
        )}
      </div>
    </div>
  );
}

export default function LeagueFixturesPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const { league, viewer } = useLeague();
  // Every format EXCEPT fpl-classic, which has none of this page's underlying data (no teams,
  // no fixtures, no playoff bracket). Listing the three explicitly rather than excluding one
  // keeps the existing formats' behaviour byte-identical.
  useEnforceFormat(["tvt", "continental-championship", "auction"]);

  const leagueName = league.name;
  const leagueFormat = league.format;
  const isLoggedIn = viewer.authenticated;
  const dashboardHref = viewer.dashboardHref;

  const [fixtures, setFixtures] = useState<GameweekFixtures>({});
  const [chipsByGameweek, setChipsByGameweek] = useState<ChipsByGameweek>({});
  const [playersByTeamId, setPlayersByTeamId] = useState<PlayersByTeamId>({});
  const [fplChipsByFplId, setFplChipsByFplId] = useState<FplChipsByFplId>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedGW, setSelectedGW] = useState<number | null>(null);
  const [availableGWs, setAvailableGWs] = useState<number[]>([]);
  const [liveScores, setLiveScores] = useState<LiveFixtureScore[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [liveCachedAt, setLiveCachedAt] = useState<string | null>(null);
  const [isManuallyRefreshed, setIsManuallyRefreshed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // First live fetch for the selected gameweek. Without this the badge falls
  // through to "Upcoming" while loading, which is not a neutral placeholder —
  // it is the same badge a gameweek that has genuinely not kicked off shows.
  const [isLoadingLive, setIsLoadingLive] = useState(true);
  // A refresh the reader did not ask for, triggered because the served copy was
  // past its fresh window.
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);

  /**
   * Re-sweep FPL behind the numbers already on screen.
   *
   * Deliberately does NOT set isManuallyRefreshed: that flag turns the badge
   * amber to mean "you forced this", and the reader did nothing. Any failure —
   * including the 503 returned while a scoring run holds the lock — leaves the
   * stale scores in place rather than blanking them.
   */
  const refreshInBackground = useCallback(async (gw: number) => {
    setIsBackgroundRefreshing(true);
    try {
      const res = await fetch(
        `/api/fixtures/live/refresh?gameweek=${gw}&leagueSlug=${encodeURIComponent(leagueSlug)}`,
      );
      if (res.ok) {
        const data = await res.json();
        if (data.fixtures?.length) {
          setLiveScores(data.fixtures);
          setIsLive(true);
          setLiveCachedAt(data.cachedAt || null);
        }
      }
    } catch {
      // Keep what is on screen.
    } finally {
      setIsBackgroundRefreshing(false);
    }
  }, [leagueSlug]);

  const fetchLiveScores = useCallback(async (gw: number) => {
    try {
      const res = await fetch(`/api/fixtures/live?gameweek=${gw}&leagueSlug=${encodeURIComponent(leagueSlug)}`);
      if (res.ok) {
        const data = await res.json();
        setLiveScores(data.fixtures || []);
        setIsLive(data.isLive ?? false);
        setLiveCachedAt(data.cachedAt || null);
        setIsManuallyRefreshed(false);
        // Served past its fresh window: show it now, replace it shortly.
        if (data.stale) void refreshInBackground(gw);
      }
    } catch {
      // Silently fail — live scores are optional
    } finally {
      setIsLoadingLive(false);
    }
  }, [leagueSlug, refreshInBackground]);

  const handleRefresh = async () => {
    if (!selectedGW || isRefreshing) return;
    setIsRefreshing(true);
    try {
      const res = await fetch(`/api/fixtures/live/refresh?gameweek=${selectedGW}&leagueSlug=${encodeURIComponent(leagueSlug)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.fixtures?.length) {
          setLiveScores(data.fixtures);
          setIsLive(true);
          setLiveCachedAt(data.cachedAt || null);
          setIsManuallyRefreshed(true);
        }
      }
    } catch {
      // Silently fail
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!selectedGW) return;
    setIsLoadingLive(true);
    fetchLiveScores(selectedGW);
    const interval = setInterval(() => fetchLiveScores(selectedGW), 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [selectedGW, fetchLiveScores]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  useEffect(() => {
    const fetchFixtures = async () => {
      try {
        const response = await fetch(`/api/fixtures?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (!response.ok) throw new Error("Failed to fetch fixtures");
        const data = await response.json();
        const fixturesData = data.fixtures || {};
        // For Continental Championship, show all 38 GWs; for TVT, show up to playoffStartGw - 1
        const leaguePhaseEnd: number = leagueFormat === "continental-championship" ? 38 : (data.playoffStartGw ? data.playoffStartGw - 1 : league.playoffStartGw - 1);
        setFixtures(fixturesData);
        // Absent on a legacy cached payload — treat that as "no chips" rather than crashing.
        setChipsByGameweek(data.chipsByGameweek ?? {});
        setPlayersByTeamId(data.playersByTeamId ?? {});
        setFplChipsByFplId(data.fplChipsByFplId ?? {});

        const gws = Object.keys(fixturesData).map(Number).filter(gw => gw <= leaguePhaseEnd).sort((a, b) => a - b);
        setAvailableGWs(gws);

        if (gws.length > 0) {
          // Open on the gameweek being played, else the next one — driven by
          // deadlines, not by whether scores have been processed. The old
          // results-based rule stopped at the last *scored* gameweek, so with
          // GW1 scored and GW2 under way the page opened on GW1.
          const choices = gws
            .map((gw) => {
              const gwFixtures: Fixture[] = fixturesData[gw] || [];
              const deadline = Date.parse(String(gwFixtures[0]?.gameweek?.deadline ?? ""));
              return {
                gw,
                deadline,
                isFullyResolved: gwFixtures.length > 0 && gwFixtures.every((f) => f.result),
              };
            })
            .filter((c) => Number.isFinite(c.deadline));
          setSelectedGW(pickDefaultGameweek(choices) ?? gws[0]);
        }
      } catch (err) {
        console.error("Error fetching fixtures:", err);
        setError("Failed to load fixtures. Please try again later.");
      } finally {
        setIsLoading(false);
      }
    };
    if (leagueSlug) fetchFixtures();
  }, [leagueSlug, leagueFormat, league.playoffStartGw]);

  const selectedFixtures = selectedGW ? fixtures[selectedGW] || [] : [];
  // Chips belong to the gameweek on screen, not to whatever is live. Switching gameweeks
  // switches the chips (and each Challenge Chip's rebuilt match) with them.
  const chipsForGw: Record<string, ChipDisplay> = selectedGW ? chipsByGameweek[selectedGW] ?? {} : {};

  /**
   * In-progress challenge matches, assembled from the live scores already on this page.
   *
   * ⚠️ The `liveScores[0].gameweek === selectedGW` guard is load-bearing. `liveScores` holds
   * whichever gameweek is in flight; without the guard, navigating back to a scored GW2 would
   * redraw its challenge with GW3's numbers — the exact bleed ChallengeTip's docblock warns about
   * and that challenge-chip-tooltip.spec.ts asserts against. A settled challenge also always wins
   * over a live one, which ChallengeTip enforces by preferring `chip.challenge`.
   */
  const liveChallenges: LiveChallenges = useMemo(() => {
    if (!isLive || !selectedGW || liveScores.length === 0) return {};
    if (liveScores[0]?.gameweek !== selectedGW) return {};

    const sides = indexLiveSides(liveScores);
    const out: LiveChallenges = {};
    for (const [teamId, chip] of Object.entries(chipsForGw)) {
      if (chip.chipType !== "C" || chip.challenge) continue;
      const match = buildLiveChallengeMatch(
        { teamId, challengedTeamId: chip.challengedTeamId ?? null, gameweek: selectedGW },
        sides,
      );
      if (match) out[teamId] = match;
    }
    return out;
  }, [isLive, selectedGW, liveScores, chipsForGw]);

  const isContinentalChampionship = leagueFormat === "continental-championship";

  // Continental Championship: only show JPL fixtures on this page (cup/knockout live on JCL/JEL pages)
  const displayFixtures = isContinentalChampionship
    ? selectedFixtures.filter((f: Fixture) => !f.competitionType || f.competitionType === "jpl")
    : selectedFixtures;

  const groupAFixtures = displayFixtures.filter((f: Fixture) => !f.group?.name || f.group.name === "A");
  const groupBFixtures = displayFixtures.filter((f: Fixture) => f.group?.name === "B");
  const hasGroupB = !isContinentalChampionship && Object.values(fixtures).flat().some((f: Fixture) => f.group?.name === "B");

  const hasResults = selectedFixtures.some((f: Fixture) => f.result);
  const deadline = selectedFixtures[0]?.gameweek?.deadline;

  const formatDeadline = (deadline: Date) => {
    const date = new Date(deadline);
    return date.toLocaleDateString("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className={`min-h-screen bg-gradient-to-b ${isContinentalChampionship ? "from-[#37003c] via-[#1a0021] to-[#0d001a]" : "from-slate-900 via-purple-900 to-slate-900"}`}>
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={leagueName}
        currentPage="fixtures"
        format={leagueFormat === "auction" ? "auction" : leagueFormat === "continental-championship" ? "continental-championship" : "tvt"}
        teamSize={league.teamSize}
        isLoggedIn={isLoggedIn}
        dashboardHref={dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2 sm:mb-4">Fixtures &amp; Results</h1>
          <p className="text-sm sm:text-base text-gray-400">View upcoming matches and past results</p>
        </div>

        {isLoading ? (
          <LoadingScreen variant="fixtures" fullScreen={false} />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : availableGWs.length === 0 ? (
          <div className="text-center py-12">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
              <h2 className="text-lg sm:text-xl font-semibold text-white mb-2">No Fixtures Yet</h2>
              <p className="text-sm sm:text-base text-gray-400">Fixtures will appear here once the league admin generates them.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Gameweek Filter */}
            <div className="mb-6 sm:mb-8">
              <GwNavigator
                gws={availableGWs}
                value={selectedGW}
                onChange={setSelectedGW}
                accent={isContinentalChampionship ? "continental" : "default"}
              />
            </div>

            {/* Status Badge */}
            <div className="flex flex-wrap items-center justify-center gap-4 mb-6">
              {hasResults ? (
                <span className="px-4 py-1 rounded-full bg-green-500/20 text-green-400 text-sm font-medium">
                  Results Available
                </span>
              ) : isLoadingLive ? (
                /* Not "Upcoming": until the first fetch lands we do not know
                   whether this gameweek is live, and claiming otherwise is what
                   made the page look stuck. */
                <span className="px-4 py-1 rounded-full bg-white/10 text-gray-300 text-sm font-medium flex items-center gap-2">
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Fetching live scores…
                </span>
              ) : isLive ? (
                <span className={`px-4 py-1 rounded-full text-sm font-medium flex items-center gap-2 ${
                  isManuallyRefreshed ? "bg-amber-500/20 text-amber-400" : "bg-white/10 text-gray-300"
                }`}>
                  <span className={`h-2 w-2 rounded-full animate-pulse ${
                    isManuallyRefreshed ? "bg-amber-400" : "bg-gray-400"
                  }`}></span>
                  Live Scores
                </span>
              ) : (
                <span className="px-4 py-1 rounded-full bg-yellow-500/20 text-yellow-400 text-sm font-medium flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                  Upcoming
                </span>
              )}
              {/* Refresh button. Disabled unless the gameweek is actually live —
                  a click on a finished or not-yet-started GW costs a full FPL
                  sweep (one picks fetch per manager) to return identical numbers. */}
              <button
                onClick={handleRefresh}
                disabled={isRefreshing || !isLive}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  isRefreshing || !isLive
                    ? "bg-white/5 text-gray-500 cursor-not-allowed"
                    : "bg-white/10 text-gray-300 hover:bg-white/20"
                }`}
                title={
                  isLive
                    ? "Refresh scores"
                    : hasResults
                    ? "This gameweek is finished — scores will not change"
                    : "This gameweek has not started yet"
                }
              >
                <svg className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
              {deadline && !hasResults && !isLive && !isLoadingLive && (
                <span className="text-sm text-gray-400">Deadline: {formatDeadline(deadline)}</span>
              )}
              <LiveFreshness
                updatedAt={liveCachedAt}
                isRefreshing={isBackgroundRefreshing}
              />
            </div>

            {hasGroupB ? (
              /* Two-Column Layout: Group A | Group B */
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
                  <h2 className="text-lg sm:text-xl font-bold text-white mb-3 sm:mb-4 flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-blue-500"></span>
                    Group A
                  </h2>
                  <div className="space-y-3">
                    {groupAFixtures.length > 0 ? (
                      groupAFixtures.map((fixture: Fixture) => (
                        <FixtureCard
                          key={fixture.id}
                          fixture={fixture}
                          liveData={liveScores.find((l) => l.fixtureId === fixture.id)}
                          isFreshlyRefreshed={isManuallyRefreshed}
                          homeChip={chipsForGw[fixture.homeTeam.id ?? ""]}
                          awayChip={chipsForGw[fixture.awayTeam.id ?? ""]}
                          homeLiveChallenge={liveChallenges[fixture.homeTeam.id ?? ""]}
                          awayLiveChallenge={liveChallenges[fixture.awayTeam.id ?? ""]}
                          playersByTeamId={playersByTeamId}
                          fplChipsByFplId={fplChipsByFplId}
                        />
                      ))
                    ) : (
                      <div className="text-center text-gray-400 py-8">No fixtures</div>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-purple-500"></span>
                    Group B
                  </h2>
                  <div className="space-y-3">
                    {groupBFixtures.length > 0 ? (
                      groupBFixtures.map((fixture: Fixture) => (
                        <FixtureCard
                          key={fixture.id}
                          fixture={fixture}
                          liveData={liveScores.find((l) => l.fixtureId === fixture.id)}
                          isFreshlyRefreshed={isManuallyRefreshed}
                          homeChip={chipsForGw[fixture.homeTeam.id ?? ""]}
                          awayChip={chipsForGw[fixture.awayTeam.id ?? ""]}
                          homeLiveChallenge={liveChallenges[fixture.homeTeam.id ?? ""]}
                          awayLiveChallenge={liveChallenges[fixture.awayTeam.id ?? ""]}
                          playersByTeamId={playersByTeamId}
                          fplChipsByFplId={fplChipsByFplId}
                        />
                      ))
                    ) : (
                      <div className="text-center text-gray-400 py-8">No fixtures</div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* Single-Group Layout: no group label, centred */
              <div className="max-w-2xl mx-auto space-y-3">
                {groupAFixtures.length > 0 ? (
                  groupAFixtures.map((fixture: Fixture) => (
                    <FixtureCard
                      key={fixture.id}
                      fixture={fixture}
                      liveData={liveScores.find((l) => l.fixtureId === fixture.id)}
                      isFreshlyRefreshed={isManuallyRefreshed}
                      homeChip={chipsForGw[fixture.homeTeam.id ?? ""]}
                      awayChip={chipsForGw[fixture.awayTeam.id ?? ""]}
                      homeLiveChallenge={liveChallenges[fixture.homeTeam.id ?? ""]}
                      awayLiveChallenge={liveChallenges[fixture.awayTeam.id ?? ""]}
                      playersByTeamId={playersByTeamId}
                      fplChipsByFplId={fplChipsByFplId}
                    />
                  ))
                ) : (
                  <div className="text-center text-gray-400 py-8">No fixtures</div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
