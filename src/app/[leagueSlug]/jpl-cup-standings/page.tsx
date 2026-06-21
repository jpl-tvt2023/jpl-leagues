"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useEnforceFormat } from "@/lib/league-context";

interface CupGroupStanding {
  rank: number;
  teamId: string;
  teamName: string;
  wins: number;
  draws: number;
  losses: number;
  goalFor: number;
  goalAgainst: number;
  goalDifference: number;
  cupGroupPoints: number;
}

interface CupGroup {
  groupName: string;
  standings: CupGroupStanding[];
  processedFixtures: number;
}

interface CupStandingsData {
  [key: string]: CupGroup;
}

export default function JplCupStandingsPage() {
  useEnforceFormat(["continental-championship"]);
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [leagueName, setLeagueName] = useState<string>("");
  const [leagueId, setLeagueId] = useState<string | null>(null);
  const [cupStandings, setCupStandings] = useState<CupStandingsData>({});
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [dashboardHref, setDashboardHref] = useState("/dashboard");
  const [isStandingsSeeded, setIsStandingsSeeded] = useState(false);

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

  // Resolve leagueName + leagueId
  useEffect(() => {
    if (!leagueSlug) return;
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => {
        const league = (data.leagues || []).find((l: { slug: string; name: string; id: string }) => l.slug === leagueSlug);
        if (league) {
          setLeagueName(league.name);
          setLeagueId(league.id);
        } else {
          // League not found — stop loading so page renders (shows unseeded banner)
          setIsLoading(false);
        }
      })
      .catch(() => setIsLoading(false));
  }, [leagueSlug]);

  // Fetch cup standings once leagueId is known. Initial `isLoading=true` from useState covers
  // the cold-load path; this effect just needs to flip it false on completion via .finally().
  useEffect(() => {
    if (!leagueId) return;
    fetch(`/api/triple-crown/cup-standings?leagueId=${leagueId}`)
      .then((r) => {
        if (!r.ok) return {};
        return r.json();
      })
      .then((cupData: { cupGroupStandings?: CupStandingsData; isSeeded?: boolean }) => {
        const standings = cupData.cupGroupStandings || {};
        setCupStandings(standings);
        // Use explicit isSeeded flag from API; fall back to checking if any groups returned
        setIsStandingsSeeded(cupData.isSeeded ?? Object.keys(standings).length > 0);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [leagueId]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  if (isLoading) return <LoadingScreen variant="fixtures" fullScreen />;

  const groupOrder = ["A", "B", "C", "D"];

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
          <Link href={`/${leagueSlug}/jpl-cup-standings`} className="text-yellow-400 font-semibold transition">
            JPL Cup Standings
          </Link>
          <Link href={`/${leagueSlug}/jpl-cup-fixtures`} className="text-gray-300 hover:text-white transition">
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

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12">
        {/* Hero */}
        <div className="text-center mb-8 sm:mb-10">
          <div className="inline-flex items-center gap-2 bg-[#0066cc]/20 border border-[#0066cc]/30 rounded-full px-4 py-1.5 mb-4">
            <span className="text-[#4da6ff] text-xs font-semibold uppercase tracking-widest">JPL Cup · Continental Championship</span>
          </div>
          <h1 className="text-2xl sm:text-4xl lg:text-5xl font-extrabold text-white mb-2">
            Group Stage Standings
          </h1>
          <p className="text-sm sm:text-base text-gray-400">Cup group stage · 2025/26 Season</p>
        </div>

        {/* Unseeded banner */}
        {!isStandingsSeeded && (
          <div className="mb-8 rounded-xl border border-blue-500/20 bg-blue-500/5 px-5 py-4 text-center">
            <p className="text-blue-300 font-semibold">Group stage hasn&apos;t been seeded yet</p>
            <p className="text-blue-400/70 text-sm mt-1">Standings will appear here once the admin seeds the cup groups.</p>
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-6 mb-6 sm:mb-8 text-xs sm:text-sm">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm bg-blue-500"></span>
            <span className="text-gray-400">JCL Knockouts (Top 2 per group)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm bg-orange-400"></span>
            <span className="text-gray-400">JEL Knockouts (3rd–4th per group)</span>
          </div>
        </div>

        {/* Group Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
          {groupOrder.map((groupLetter) => {
            const groupKey = `Cup-${groupLetter}`;
            const group = cupStandings[groupKey];

            return (
              <div key={groupLetter} className="rounded-2xl border border-blue-500/20 bg-blue-950/20 backdrop-blur overflow-hidden">
                {/* Card header */}
                <div className="flex items-center gap-3 px-5 py-3 border-b border-blue-500/20 bg-[#0066cc]/10">
                  <div className="h-5 w-1 rounded-full bg-[#0066cc]" />
                  <span className="text-white font-bold text-sm uppercase tracking-wider">Group {groupLetter}</span>
                  {group && (
                    <span className="ml-auto text-xs text-gray-500">{group.processedFixtures} match{group.processedFixtures !== 1 ? "es" : ""} played</span>
                  )}
                </div>

                {/* Column headers */}
                <div className="px-3 sm:px-4 py-2 grid grid-cols-[auto_1fr_repeat(7,auto)] gap-x-2 sm:gap-x-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-b border-white/5">
                  <span className="w-5 text-center">#</span>
                  <span>Team</span>
                  <span className="w-6 text-center">P</span>
                  <span className="w-6 text-center">W</span>
                  <span className="w-6 text-center">D</span>
                  <span className="w-6 text-center">L</span>
                  <span className="w-8 text-center">GD</span>
                  <span className="w-8 text-center">Pts</span>
                </div>

                {/* Rows */}
                {group && group.standings.length > 0 ? (
                  <div>
                    {group.standings.map((team, idx) => {
                      const isUCL = idx < 2;
                      const isUEL = idx >= 2 && idx < 4;
                      const rowBg = isUCL
                        ? "bg-blue-500/10 border-l-4 border-blue-400"
                        : isUEL
                        ? "bg-orange-500/8 border-l-4 border-orange-400/50"
                        : "";
                      const played = team.wins + team.draws + team.losses;
                      const gd = team.goalDifference ?? (team.goalFor - team.goalAgainst);
                      return (
                        <div
                          key={team.teamId}
                          className={`px-3 sm:px-4 py-2 sm:py-2.5 grid grid-cols-[auto_1fr_repeat(7,auto)] gap-x-2 sm:gap-x-3 items-center text-xs sm:text-sm border-b border-white/5 last:border-0 ${rowBg}`}
                        >
                          <span className="w-5 text-center font-bold text-gray-400 text-xs">{idx + 1}</span>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-semibold text-white truncate">{team.teamName}</span>
                            {isUCL && (
                              <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">JCL</span>
                            )}
                            {isUEL && (
                              <span className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold bg-orange-500/20 text-orange-300 border border-orange-500/30">JEL</span>
                            )}
                          </div>
                          <span className="w-6 text-center text-gray-400 text-xs">{played}</span>
                          <span className="w-6 text-center text-green-400 text-xs font-semibold">{team.wins}</span>
                          <span className="w-6 text-center text-gray-400 text-xs">{team.draws}</span>
                          <span className="w-6 text-center text-red-400 text-xs">{team.losses}</span>
                          <span className={`w-8 text-center text-xs font-medium ${gd > 0 ? "text-green-400" : gd < 0 ? "text-red-400" : "text-gray-400"}`}>
                            {gd > 0 ? `+${gd}` : gd}
                          </span>
                          <span className="w-8 text-center font-bold text-white text-sm">{team.cupGroupPoints}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-5 py-6 text-center text-gray-500 text-sm">
                    Awaiting group stage results
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-8 text-center text-xs text-gray-600">
          P = Played · W = Won · D = Drawn · L = Lost · GD = Goal Difference · Pts = Points
        </div>
      </div>
    </div>
  );
}
