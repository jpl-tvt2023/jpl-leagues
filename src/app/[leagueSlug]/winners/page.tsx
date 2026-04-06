"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

interface Winner {
  position: number;
  label: string;
  category: "championship" | "challenger" | "pl" | "ucl" | "uel";
  teamId: string;
  teamName: string;
  teamAbbr: string;
  players: { name: string; fplId: string }[];
}

interface WinnersData {
  concluded: boolean;
  winners: Winner[];
}

export default function LeagueWinnersPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [data, setData] = useState<WinnersData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [leagueName, setLeagueName] = useState<string>("");
  const [leagueFormat, setLeagueFormat] = useState<string | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const me = await res.json();
        if (res.ok && me.authenticated && me.type === "team") setIsLoggedIn(true);
      } catch {}
    };

    fetch("/api/leagues")
      .then((r) => r.json())
      .then((d) => {
        const league = (d.leagues || []).find((l: { slug: string; name: string; format?: string }) => l.slug === leagueSlug);
        if (league) {
          setLeagueName(league.name);
          setLeagueFormat(league.format ?? null);
        }
      })
      .catch(() => {});

    checkAuth();
  }, [leagueSlug]);

  useEffect(() => {
    const fetchWinners = async () => {
      try {
        const res = await fetch(`/api/playoffs/winners?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (res.ok) {
          const winners = await res.json();
          setData(winners);
        }
      } catch (err) {
        console.error("Failed to fetch winners:", err);
      } finally {
        setIsLoading(false);
      }
    };

    if (leagueSlug) fetchWinners();
  }, [leagueSlug]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const getTrophyEmoji = (position: number) => {
    if (position === 1) return "🥇";
    if (position === 2) return "🥈";
    if (position === 3) return "🥉";
    return "⭐";
  };

  const getCategoryColor = (category: string) => {
    if (category === "championship" || category === "pl") return "text-blue-400";
    if (category === "ucl") return "text-blue-300";
    if (category === "uel") return "text-purple-300";
    return "text-yellow-400"; // challenger
  };

  const getCategoryBg = (category: string, position: number) => {
    if (position <= 3) {
      if (position === 1) return "bg-gradient-to-r from-yellow-900/40 to-yellow-800/20";
      if (position === 2) return "bg-gradient-to-r from-gray-600/40 to-gray-500/20";
      return "bg-gradient-to-r from-amber-900/40 to-amber-800/20";
    }
    if (category === "championship" || category === "pl") return "bg-blue-900/20";
    if (category === "ucl") return "bg-blue-800/20";
    if (category === "uel") return "bg-purple-900/20";
    return "bg-yellow-900/20"; // challenger
  };

  if (isLoading) {
    return <LoadingScreen variant="standings" fullScreen />;
  }

  const isTripleCrown = leagueFormat === "triple-crown";

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
          <Link href={isLoggedIn ? "/dashboard" : "/"} className="text-gray-300 hover:text-white transition">
            {isLoggedIn ? "Dashboard" : "All Leagues"}
          </Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">
            {isTripleCrown ? "PL Standings" : "Standings"}
          </Link>
          <Link href={`/${leagueSlug}/fixtures`} className="text-gray-300 hover:text-white transition">
            {isTripleCrown ? "PL Fixtures" : "Fixtures"}
          </Link>
          {isTripleCrown ? (
            <>
              <Link href={`/${leagueSlug}/uefa-standings`} className="text-gray-300 hover:text-white transition">UEFA Standings</Link>
              <Link href={`/${leagueSlug}/uefa-fixtures`} className="text-gray-300 hover:text-white transition">UEFA Fixtures</Link>
              <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">Playoffs</Link>
            </>
          ) : (
            <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">
              Playoffs
            </Link>
          )}
          <Link href={`/${leagueSlug}/winners`} className="text-yellow-400 font-semibold transition">
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
        <div className="text-center mb-12">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-2">Hall of Champions</h1>
          <p className="text-gray-400">Season winners and finalists</p>
        </div>

        {!data?.concluded ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="text-center max-w-md">
              <div className="text-6xl mb-4">⏳</div>
              <h2 className="text-2xl font-bold text-white mb-2">Tournament in Progress</h2>
              <p className="text-gray-400">
                Winners will be crowned once the championship finals are concluded.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[500px]">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="px-4 py-3 text-left text-gray-400 text-sm font-semibold">Rank</th>
                  <th className="px-4 py-3 text-left text-gray-400 text-sm font-semibold">Position</th>
                  <th className="px-4 py-3 text-left text-gray-400 text-sm font-semibold">Team</th>
                  <th className="px-4 py-3 text-left text-gray-400 text-sm font-semibold">Players</th>
                  <th className="px-4 py-3 text-left text-gray-400 text-sm font-semibold">Category</th>
                </tr>
              </thead>
              <tbody>
                {data.winners.map((winner) => (
                  <tr
                    key={winner.position}
                    className={`border-b border-white/5 transition ${getCategoryBg(winner.category, winner.position)}`}
                  >
                    <td className="px-4 py-4 text-center text-2xl">{getTrophyEmoji(winner.position)}</td>
                    <td className="px-4 py-4">
                      <div className="text-white font-bold">{winner.label}</div>
                      <div className="text-xs text-gray-400 mt-1"># {winner.position}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="text-white font-semibold">{winner.teamName}</div>
                      <div className="text-xs text-gray-400">{winner.teamAbbr}</div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="space-y-1">
                        {winner.players.map((player, idx) => (
                          <div key={idx} className="text-sm">
                            <a
                              href={`https://fantasy.premierleague.com/entry/${player.fplId}/event/38`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 underline"
                            >
                              {player.name}
                            </a>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span
                        className={`inline-block px-3 py-1 rounded-full text-xs font-semibold ${
                          winner.category === "championship"
                            ? "bg-blue-900/60 text-blue-200"
                            : "bg-yellow-900/60 text-yellow-200"
                        }`}
                      >
                        {winner.category === "championship" ? "Championship" : "Challenger"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
