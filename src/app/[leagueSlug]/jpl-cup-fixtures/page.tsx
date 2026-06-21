"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useEnforceFormat } from "@/lib/league-context";
import {
  type Fixture,
  type GameweekFixtures,
  type LiveFixtureScore,
  PlayerBreakdown,
} from "../_components/fixtures/shared";

export default function JplCupFixturesPage() {
  useEnforceFormat(["continental-championship"]);
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [leagueName, setLeagueName] = useState<string>("");
  const [fixtures, setFixtures] = useState<GameweekFixtures>({});
  const [availableGWs, setAvailableGWs] = useState<number[]>([]);
  const [selectedGW, setSelectedGW] = useState<number | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [dashboardHref, setDashboardHref] = useState("/dashboard");

  // Expanded fixture cards
  const [expandedFixtures, setExpandedFixtures] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) => setExpandedFixtures(prev => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  // Live scoring
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
        setLiveScores(data.fixtures || []);
        setIsLive(data.isLive ?? false);
        setLiveCachedAt(data.cachedAt || null);
        setIsManuallyRefreshed(false);
      }
    } catch {
      // Silently fail — live scores are optional
    }
  }, [leagueSlug]);

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

  // Auth check
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        setIsLoggedIn(d.authenticated && (d.type === "team" || d.type === "admin" || d.type === "superadmin"));
        if (d.type === "admin" && d.adminLeagueId) setDashboardHref(`/admin/${d.adminLeagueId}`);
        else if (d.type === "superadmin") setDashboardHref("/admin");
      })
      .catch(() => setIsLoggedIn(false));
  }, []);

  // Fetch league name + fixtures
  useEffect(() => {
    if (!leagueSlug) return;
    setIsLoading(true);

    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => {
        const league = (data.leagues || []).find((l: { slug: string; name: string }) => l.slug === leagueSlug);
        if (league) setLeagueName(league.name);
      })
      .catch(() => {});

    fetch(`/api/fixtures?leagueSlug=${encodeURIComponent(leagueSlug)}`)
      .then((r) => r.json())
      .then((data) => {
        const allFixtures = data.fixtures || {};
        const cupGWs = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24];
        const cupFixtures: GameweekFixtures = {};
        for (const gw of cupGWs) {
          if (allFixtures[gw]) {
            const filtered = allFixtures[gw].filter(
              (f: Fixture) => f.competitionType === "cup-group"
            );
            if (filtered.length > 0) cupFixtures[gw] = filtered;
          }
        }
        const available = cupGWs.filter((gw) => cupFixtures[gw]?.length > 0);
        setFixtures(cupFixtures);
        setAvailableGWs(available);
        if (available.length > 0) {
          // Default to latest fully-concluded GW; if mid-flight, use that; else use first GW
          let best = available[0];
          for (const gw of available) {
            const gwFixtures = cupFixtures[gw] || [];
            const allDone = gwFixtures.length > 0 && gwFixtures.every((f: Fixture) => f.result);
            const anyDone = gwFixtures.some((f: Fixture) => f.result);
            if (allDone) {
              best = gw;
            } else if (anyDone) {
              best = gw;
              break;
            } else {
              break;
            }
          }
          setSelectedGW(best);
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [leagueSlug]);

  // Auto-poll live scores every 10 minutes
  useEffect(() => {
    if (!selectedGW) return;
    fetchLiveScores(selectedGW);
    const interval = setInterval(() => fetchLiveScores(selectedGW), 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [selectedGW, fetchLiveScores]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  if (isLoading) return <LoadingScreen variant="fixtures" fullScreen />;

  const selectedFixtures = selectedGW ? (fixtures[selectedGW] || []) : [];

  // Group fixtures by cup group letter
  const groupedFixtures = new Map<string, Fixture[]>();
  for (const fixture of selectedFixtures) {
    const letter = fixture.group?.name?.replace("Cup-", "") || "?";
    if (!groupedFixtures.has(letter)) groupedFixtures.set(letter, []);
    groupedFixtures.get(letter)!.push(fixture);
  }
  const groupOrder = ["A", "B", "C", "D"];
  const sortedGroups = groupOrder.filter((g) => groupedFixtures.has(g));

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#061a33] via-[#08213d] to-[#040f1e]">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10 bg-[#061a33]/80 backdrop-blur">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            JPL
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">{leagueName || "League"}</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href={isLoggedIn ? dashboardHref : "/"} className="text-gray-300 hover:text-white transition">
            {isLoggedIn ? "Dashboard" : "All Leagues"}
          </Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">
            JPL Standings
          </Link>
          <Link href={`/${leagueSlug}/fixtures`} className="text-gray-300 hover:text-white transition">
            JPL Fixtures
          </Link>
          <Link href={`/${leagueSlug}/jpl-cup-standings`} className="text-gray-300 hover:text-white transition">
            JPL Cup Standings
          </Link>
          <Link href={`/${leagueSlug}/jpl-cup-fixtures`} className="text-yellow-400 font-semibold transition">
            JPL Cup Fixtures
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

      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8 sm:py-12">
        {/* Hero */}
        <div className="text-center mb-6 sm:mb-10">
          <div className="inline-flex items-center gap-2 bg-[#0066cc]/20 border border-[#0066cc]/30 rounded-full px-4 py-1.5 mb-4">
            <span className="text-[#4da6ff] text-xs font-semibold uppercase tracking-widest">JPL Cup · Continental Championship</span>
          </div>
          <h1 className="text-2xl sm:text-4xl lg:text-5xl font-extrabold text-white mb-2">Group Stage Fixtures</h1>
          <p className="text-sm sm:text-base text-gray-400">Cup group stage · 2025/26 Season</p>
        </div>

        {availableGWs.length === 0 ? (
          <div className="text-center rounded-xl border border-blue-500/20 bg-blue-500/5 px-5 py-10">
            <p className="text-blue-300 font-semibold">No group stage fixtures yet</p>
            <p className="text-blue-400/70 text-sm mt-1">Cup group fixtures will appear here once the group stage begins (GW6+).</p>
          </div>
        ) : (
          <>
            {/* GW Selector + Live controls */}
            <div className="flex flex-wrap items-center justify-center gap-4 mb-8">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    const idx = availableGWs.indexOf(selectedGW!);
                    if (idx > 0) setSelectedGW(availableGWs[idx - 1]);
                  }}
                  disabled={selectedGW === availableGWs[0]}
                  className="p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 transition"
                >
                  ←
                </button>
                <select
                  value={selectedGW || ""}
                  onChange={(e) => setSelectedGW(Number(e.target.value))}
                  className="bg-[#0d2a4a] border border-blue-500/30 rounded-lg px-4 py-2 text-white font-semibold"
                >
                  {availableGWs.map((gw) => (
                    <option key={gw} value={gw} className="bg-slate-800">
                      Gameweek {gw}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => {
                    const idx = availableGWs.indexOf(selectedGW!);
                    if (idx < availableGWs.length - 1) setSelectedGW(availableGWs[idx + 1]);
                  }}
                  disabled={selectedGW === availableGWs[availableGWs.length - 1]}
                  className="p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 transition"
                >
                  →
                </button>
              </div>

              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${
                  isRefreshing ? "bg-white/10 text-gray-400" : "bg-white/10 text-gray-300 hover:bg-white/20"
                }`}
              >
                <span className={isRefreshing ? "animate-spin" : ""}>↻</span>
                {isRefreshing ? "Refreshing..." : "Refresh Scores"}
              </button>
            </div>

            {liveCachedAt && (
              <div className="text-center mb-4">
                <span className="inline-flex items-center gap-1.5 text-xs text-amber-400/70">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-50" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400" />
                  </span>
                  {isManuallyRefreshed ? "Live" : "Cached"} · Updated {new Date(liveCachedAt).toLocaleTimeString()}
                </span>
              </div>
            )}

            {/* Fixtures by group — 2-column grid (A|B / C|D) on md+ */}
            {sortedGroups.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-8">
              {sortedGroups.map((groupLetter) => {
                const groupFixtures = groupedFixtures.get(groupLetter)!;
                return (
                  <div key={groupLetter}>
                    {/* Group header */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-5 w-1 rounded-full bg-[#0066cc]" />
                      <span className="text-white font-bold text-sm uppercase tracking-wider">Group {groupLetter}</span>
                      <div className="flex-1 h-px bg-white/10" />
                    </div>

                    <div className="space-y-2">
                      {groupFixtures.map((fixture) => {
                        const live = liveScores.find((ls) => ls.fixtureId === fixture.id);
                        const hasResult = !!fixture.result;
                        const isFixtureLive = !!live;
                        const isGhostFixture = !!(fixture.homeTeam.isGhost || fixture.awayTeam.isGhost);
                        const hasPlayerData = (live?.homePlayers?.length ?? 0) > 0 || !!(fixture.result?.homePlayerScores) || hasResult;
                        const isExpanded = expandedFixtures.has(fixture.id);

                        return (
                          <div
                            key={fixture.id}
                            className={`rounded-xl border p-4 backdrop-blur transition ${
                              isGhostFixture
                                ? "border-purple-500/20 bg-purple-950/10"
                                : isFixtureLive
                                ? "border-amber-500/30 bg-amber-500/5"
                                : hasResult
                                ? "border-white/10 bg-white/5"
                                : "border-blue-500/15 bg-blue-950/20"
                            } cursor-pointer`}
                            onClick={() => toggleExpand(fixture.id)}
                          >
                            <div className="flex items-center gap-2 sm:gap-3">
                              {/* Home team */}
                              <div className="flex-1 min-w-0 text-right">
                                <span className={`font-semibold text-xs sm:text-sm truncate inline-block max-w-full ${fixture.homeTeam.isGhost ? "text-purple-400 italic" : "text-white"}`}>{fixture.homeTeam.name}</span>
                              </div>

                              {/* Score box */}
                              <div className={`shrink-0 min-w-[60px] sm:min-w-[72px] text-center rounded-lg px-2 sm:px-3 py-1.5 sm:py-2 border ${
                                isFixtureLive
                                  ? "bg-amber-900/40 border-amber-500/40"
                                  : hasResult
                                  ? "bg-green-900/30 border-green-500/30"
                                  : "bg-blue-900/20 border-blue-500/20"
                              }`}>
                                {isFixtureLive ? (
                                  <span className="text-lg font-bold text-amber-400 animate-pulse">
                                    {live.homeScore} – {live.awayScore}
                                  </span>
                                ) : hasResult ? (
                                  <span className="text-lg font-bold text-green-400">
                                    {fixture.result!.homeScore} – {fixture.result!.awayScore}
                                  </span>
                                ) : (
                                  <span className="text-sm text-gray-500 font-medium">vs</span>
                                )}
                              </div>

                              {/* Away team */}
                              <div className="flex-1 min-w-0 text-left">
                                <span className={`font-semibold text-xs sm:text-sm truncate inline-block max-w-full ${fixture.awayTeam.isGhost ? "text-purple-400 italic" : "text-white"}`}>{fixture.awayTeam.name}</span>
                              </div>
                            </div>

                            {/* Player breakdown toggle — Ghost fixtures still show the human side's breakdown */}
                            <div className="mt-2">
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleExpand(fixture.id); }}
                                className="w-full text-center text-[10px] text-gray-500 hover:text-gray-300 transition py-1"
                              >
                                {isExpanded ? "▲ Hide breakdown" : "▼ Player breakdown"}
                              </button>
                              {isExpanded && (
                                (hasPlayerData || isGhostFixture)
                                  ? <PlayerBreakdown fixture={fixture} liveData={live} />
                                  : <div className="mt-2 p-3 rounded-lg bg-white/5 border border-white/10 text-center text-xs text-gray-400">
                                      Player breakdown not yet available — FPL data will appear once the gameweek begins.
                                    </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            ) : (
              <div className="text-center text-gray-500 py-8">No cup group fixtures in this gameweek</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
