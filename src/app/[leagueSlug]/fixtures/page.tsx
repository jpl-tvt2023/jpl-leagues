"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

interface LivePlayerScore {
  name: string;
  fplId: string;
  fplScore: number;
  transferHits: number;
  isCaptain: boolean;
  isAutoAssigned?: boolean;
  finalScore: number;
}

interface LiveFixtureScore {
  fixtureId: string;
  gameweek: number;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  homeScore: number;
  awayScore: number;
  homePlayers: LivePlayerScore[];
  awayPlayers: LivePlayerScore[];
}

interface Fixture {
  id: string;
  homeTeam: { name: string; abbreviation: string };
  awayTeam: { name: string; abbreviation: string };
  group: { name: string } | null;
  gameweek: { number: number; deadline: Date };
  result?: {
    homeScore: number;
    awayScore: number;
    homeMatchPoints: number;
    awayMatchPoints: number;
    homePlayerScores?: string | null;
    awayPlayerScores?: string | null;
  } | null;
}

interface GameweekFixtures {
  [key: number]: Fixture[];
}

function FixtureCard({
  fixture,
  liveData,
  isFreshlyRefreshed,
}: {
  fixture: Fixture;
  liveData?: LiveFixtureScore;
  isFreshlyRefreshed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const result = fixture.result;
  const isResult = result !== undefined && result !== null;
  const isLive = !isResult && !!liveData;

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

  const hasPlayerData = isLive
    ? (liveData?.homePlayers.length ?? 0) > 0
    : !!(fixture.result?.homePlayerScores);

  return (
    <div
      className={`rounded-xl border p-4 backdrop-blur transition ${
        isLive ? "border-green-500/30 bg-green-500/5" : "border-white/10 bg-white/5"
      } ${hasPlayerData ? "cursor-pointer" : ""}`}
      onClick={() => hasPlayerData && setExpanded(!expanded)}
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

      <div className="flex items-center justify-between">
        <div className="flex-1 text-left text-white">
          <div className="font-semibold text-sm">{fixture.homeTeam.name}</div>
        </div>

        <div className="flex items-center gap-2 px-3">
          {hasScore ? (
            <>
              <span className={`text-xl font-bold ${homeScoreClass}`}>{homeScore}</span>
              <span className="text-gray-500">-</span>
              <span className={`text-xl font-bold ${awayScoreClass}`}>{awayScore}</span>
            </>
          ) : (
            <span className="text-gray-500 font-medium text-sm">VS</span>
          )}
        </div>

        <div className="flex-1 text-right text-white">
          <div className="font-semibold text-sm">{fixture.awayTeam.name}</div>
        </div>
      </div>

      {(() => {
        const homePlayers: LivePlayerScore[] = isLive
          ? (liveData?.homePlayers ?? [])
          : fixture.result?.homePlayerScores
            ? JSON.parse(fixture.result.homePlayerScores)
            : [];
        const awayPlayers: LivePlayerScore[] = isLive
          ? (liveData?.awayPlayers ?? [])
          : fixture.result?.awayPlayerScores
            ? JSON.parse(fixture.result.awayPlayerScores)
            : [];
        const gwNumber = liveData?.gameweek ?? fixture.gameweek.number;
        if (homePlayers.length === 0) return null;
        return (
          <div className="mt-2">
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              className="w-full text-center text-[10px] text-gray-500 hover:text-gray-300 transition py-1"
            >
              {expanded ? "▲ Hide breakdown" : "▼ Player breakdown"}
            </button>
            {expanded && (
              <div className="mt-1 pt-2 border-t border-white/10 grid grid-cols-2 gap-2 sm:gap-4 text-xs">
                <div>
                  <div className="text-[10px] text-gray-400 mb-1 text-center">{fixture.homeTeam.name}</div>
                  {homePlayers.map((p, i) => (
                    <div key={i} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-1 min-w-0">
                        <a
                          href={`https://fantasy.premierleague.com/entry/${p.fplId}/event/${gwNumber}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 underline truncate"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.name}
                        </a>
                        {p.isCaptain && !p.isAutoAssigned && (
                          <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-yellow-500/20 text-yellow-400 shrink-0">C</span>
                        )}
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        {p.isCaptain && !p.isAutoAssigned ? (
                          <span className="text-yellow-400 font-semibold">
                            {p.fplScore}{p.transferHits > 0 ? ` - ${p.transferHits}` : ""} ×2 = {p.finalScore}
                          </span>
                        ) : (
                          <span className="text-white">
                            {p.finalScore}{p.transferHits > 0 ? ` (−${p.transferHits})` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-[10px] text-gray-400 mb-1 text-center">{fixture.awayTeam.name}</div>
                  {awayPlayers.map((p, i) => (
                    <div key={i} className="flex items-center justify-between py-1">
                      <div className="flex items-center gap-1 min-w-0">
                        <a
                          href={`https://fantasy.premierleague.com/entry/${p.fplId}/event/${gwNumber}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 underline truncate"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.name}
                        </a>
                        {p.isCaptain && !p.isAutoAssigned && (
                          <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-yellow-500/20 text-yellow-400 shrink-0">C</span>
                        )}
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        {p.isCaptain && !p.isAutoAssigned ? (
                          <span className="text-yellow-400 font-semibold">
                            {p.fplScore}{p.transferHits > 0 ? ` - ${p.transferHits}` : ""} ×2 = {p.finalScore}
                          </span>
                        ) : (
                          <span className="text-white">
                            {p.finalScore}{p.transferHits > 0 ? ` (−${p.transferHits})` : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

export default function LeagueFixturesPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [fixtures, setFixtures] = useState<GameweekFixtures>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [leagueName, setLeagueName] = useState<string>("");
  const [selectedGW, setSelectedGW] = useState<number | null>(null);
  const [availableGWs, setAvailableGWs] = useState<number[]>([]);
  const [liveScores, setLiveScores] = useState<LiveFixtureScore[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [liveCachedAt, setLiveCachedAt] = useState<string | null>(null);
  const [isManuallyRefreshed, setIsManuallyRefreshed] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchLiveScores = useCallback(async (gw: number) => {
    try {
      const res = await fetch(`/api/fixtures/live?gameweek=${gw}&leagueSlug=${encodeURIComponent(leagueSlug)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.isLive) {
          setLiveScores(data.fixtures || []);
          setIsLive(true);
          setLiveCachedAt(data.cachedAt || null);
          setIsManuallyRefreshed(false);
        } else {
          setLiveScores([]);
          setIsLive(false);
          setLiveCachedAt(null);
          setIsManuallyRefreshed(false);
        }
      }
    } catch {
      // Silently fail — live scores are optional
    }
  }, []);

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
    fetchLiveScores(selectedGW);
    const interval = setInterval(() => fetchLiveScores(selectedGW), 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [selectedGW, fetchLiveScores]);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        setIsLoggedIn(res.ok && data.authenticated && data.type === "team");
      } catch {
        setIsLoggedIn(false);
      }
    };
    checkAuth();
  }, []);

  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => {
        const league = (data.leagues || []).find((l: { slug: string; name: string }) => l.slug === leagueSlug);
        if (league) setLeagueName(league.name);
      })
      .catch(() => {});
  }, [leagueSlug]);

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
        // For Triple Crown, show all 38 GWs; for TVT, show up to playoffStartGw - 1
        const leaguePhaseEnd: number = data.format === "triple-crown" ? 38 : (data.playoffStartGw ? data.playoffStartGw - 1 : Infinity);
        setFixtures(fixturesData);

        const gws = Object.keys(fixturesData).map(Number).filter(gw => gw <= leaguePhaseEnd).sort((a, b) => a - b);
        setAvailableGWs(gws);

        if (gws.length > 0) {
          let currentGW = gws[0];
          for (const gw of gws) {
            const gwFixtures = fixturesData[gw] || [];
            const hasResults = gwFixtures.some((f: Fixture) => f.result);
            const allProcessed = gwFixtures.every((f: Fixture) => f.result);

            if (hasResults && !allProcessed) {
              currentGW = gw;
              break;
            } else if (!hasResults) {
              currentGW = gw;
              break;
            } else {
              currentGW = gw;
            }
          }
          setSelectedGW(currentGW);
        }
      } catch (err) {
        console.error("Error fetching fixtures:", err);
        setError("Failed to load fixtures. Please try again later.");
      } finally {
        setIsLoading(false);
      }
    };
    if (leagueSlug) fetchFixtures();
  }, [leagueSlug]);

  const selectedFixtures = selectedGW ? fixtures[selectedGW] || [] : [];
  const groupAFixtures = selectedFixtures.filter((f: Fixture) => !f.group?.name || f.group.name === "A");
  const groupBFixtures = selectedFixtures.filter((f: Fixture) => f.group?.name === "B");
  const hasGroupB = Object.values(fixtures).flat().some((f: Fixture) => f.group?.name === "B");

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
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10 bg-slate-900/80 backdrop-blur">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            JPL
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">{leagueName || "League"}</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href={isLoggedIn ? "/dashboard" : "/"} className="text-gray-300 hover:text-white transition">{isLoggedIn ? "Dashboard" : "All Leagues"}</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">
            Standings
          </Link>
          <Link href={`/${leagueSlug}/fixtures`} className="text-yellow-400 font-semibold transition">
            Fixtures
          </Link>
          <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">
            Playoffs
          </Link>
          <Link href={`/${leagueSlug}/winners`} className="text-gray-300 hover:text-white transition">
            Winners
          </Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">
            Rules
          </Link>
          <Link href={`/${leagueSlug}/help`} className="text-gray-300 hover:text-white transition">
            Help
          </Link>
          {isLoggedIn ? (
            <button
              onClick={handleSignOut}
              className="rounded-full bg-white/10 px-6 py-2 font-semibold text-white hover:bg-white/20 transition"
            >
              Sign Out
            </button>
          ) : (
            <Link
              href="/signin"
              className="rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-2 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition"
            >
              Sign In
            </Link>
          )}
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-4">Fixtures &amp; Results</h1>
          <p className="text-gray-400">View upcoming matches and past results</p>
        </div>

        {isLoading ? (
          <LoadingScreen variant="fixtures" fullScreen={false} />
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : availableGWs.length === 0 ? (
          <div className="text-center py-12">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
              <h2 className="text-xl font-semibold text-white mb-2">No Fixtures Yet</h2>
              <p className="text-gray-400">Fixtures will appear here once the league admin generates them.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Gameweek Filter */}
            <div className="flex items-center justify-center gap-4 mb-8">
              <button
                onClick={() => setSelectedGW(prev => {
                  const idx = availableGWs.indexOf(prev!);
                  return idx > 0 ? availableGWs[idx - 1] : prev;
                })}
                disabled={selectedGW === availableGWs[0]}
                className="p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>

              <select
                value={selectedGW || ""}
                onChange={(e) => setSelectedGW(Number(e.target.value))}
                className="bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white font-semibold min-w-[180px] text-center appearance-none cursor-pointer hover:bg-white/20 transition"
              >
                {availableGWs.map((gw) => (
                  <option key={gw} value={gw} className="bg-slate-800 text-white">
                    Gameweek {gw}
                  </option>
                ))}
              </select>

              <button
                onClick={() => setSelectedGW(prev => {
                  const idx = availableGWs.indexOf(prev!);
                  return idx < availableGWs.length - 1 ? availableGWs[idx + 1] : prev;
                })}
                disabled={selectedGW === availableGWs[availableGWs.length - 1]}
                className="p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            {/* Status Badge */}
            <div className="flex flex-wrap items-center justify-center gap-4 mb-6">
              {hasResults ? (
                <span className="px-4 py-1 rounded-full bg-green-500/20 text-green-400 text-sm font-medium">
                  Results Available
                </span>
              ) : isLive ? (
                <span className={`px-4 py-1 rounded-full text-sm font-medium flex items-center gap-2 ${
                  isManuallyRefreshed ? "bg-amber-500/20 text-amber-400" : "bg-white/10 text-gray-300"
                }`}>
                  <span className={`h-2 w-2 rounded-full animate-pulse ${
                    isManuallyRefreshed ? "bg-amber-400" : "bg-gray-400"
                  }`}></span>
                  Live Scores
                  <button
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                    className="ml-1 p-0.5 rounded hover:bg-white/10 transition disabled:opacity-50"
                    title="Refresh live scores"
                  >
                    <svg className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                </span>
              ) : (
                <span className="px-4 py-1 rounded-full bg-yellow-500/20 text-yellow-400 text-sm font-medium flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-yellow-400 animate-pulse"></span>
                  Upcoming
                </span>
              )}
              {deadline && !hasResults && !isLive && (
                <span className="text-sm text-gray-400">Deadline: {formatDeadline(deadline)}</span>
              )}
              {isLive && liveCachedAt && (
                <span className="text-xs text-gray-500">
                  Updated: {new Date(liveCachedAt).toLocaleTimeString()}
                </span>
              )}
            </div>

            {hasGroupB ? (
              /* Two-Column Layout: Group A | Group B */
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
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
