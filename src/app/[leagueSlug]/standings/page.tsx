"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { StandingsTable } from "@/components/StandingsTable";
import type { TeamStanding } from "@/types/standings";

export default function LeagueStandingsPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [groupA, setGroupA] = useState<TeamStanding[]>([]);
  const [groupB, setGroupB] = useState<TeamStanding[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [latestGameweek, setLatestGameweek] = useState<number>(0);
  const [leagueStageEnd, setLeagueStageEnd] = useState<number>(30);
  const [teamSize, setTeamSize] = useState<number>(32);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [leagueName, setLeagueName] = useState<string>("");

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        setIsLoggedIn(res.ok && data.authenticated);
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
    const fetchStandings = async () => {
      try {
        const response = await fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (!response.ok) throw new Error("Failed to fetch standings");
        const data = await response.json();
        setGroupA(data.groupA || []);
        setGroupB(data.groupB || []);
        if (data.leagueStageEnd) setLeagueStageEnd(data.leagueStageEnd);
        if (data.teamSize) setTeamSize(data.teamSize);
        const stageEnd: number = data.leagueStageEnd ?? 30;
        const maxPlayed = Math.min(
          Math.max(
            ...data.groupA.map((t: TeamStanding) => t.played),
            ...data.groupB.map((t: TeamStanding) => t.played),
            0
          ),
          stageEnd
        );
        setLatestGameweek(maxPlayed);
      } catch (err) {
        console.error("Error fetching standings:", err);
        setError("Failed to load standings. Please try again later.");
      } finally {
        setIsLoading(false);
      }
    };
    if (leagueSlug) fetchStandings();
  }, [leagueSlug]);

  const totalTeams = groupA.length + groupB.length;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            JPL
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">{leagueName || "League"}</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/" className="text-gray-300 hover:text-white transition">All Leagues</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-yellow-400 font-semibold transition">
            Standings
          </Link>
          <Link href={`/${leagueSlug}/fixtures`} className="text-gray-300 hover:text-white transition">
            Fixtures
          </Link>
          <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">
            Playoffs
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

      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-12">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-4">League Standings</h1>
          <p className="text-gray-400">
            {latestGameweek > 0
              ? `After Gameweek ${latestGameweek} · League Stage`
              : totalTeams > 0
                ? "League Stage · No matches played yet"
                : "League Stage · Awaiting teams"
            }
          </p>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center justify-center gap-6 mb-8 text-sm">
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
            <span className="text-gray-400">Eliminated ({teamSize === 8 ? "5-8" : "15-16"})</span>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center text-gray-400 py-12">Loading standings...</div>
        ) : error ? (
          <div className="text-center text-red-400 py-12">{error}</div>
        ) : totalTeams === 0 ? (
          <div className="text-center py-12">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
              <h2 className="text-xl font-semibold text-white mb-2">No Teams Yet</h2>
              <p className="text-gray-400">Standings will appear here once teams are registered and matches are played.</p>
            </div>
          </div>
        ) : (
          <div className={`grid gap-8 ${groupB.length > 0 ? "lg:grid-cols-2" : "max-w-2xl mx-auto"}`}>
            <StandingsTable teams={groupA} group="A" />
            {groupB.length > 0 && <StandingsTable teams={groupB} group="B" />}
          </div>
        )}

        <div className="mt-8 text-center text-sm text-gray-500">
          MP = Matches Played · W = Won · D = Drawn · L = Lost · CP/BP = Chips &amp; Bonus Points · Pts = League Points · Scores = Total FPL Score
        </div>
      </div>
    </div>
  );
}
