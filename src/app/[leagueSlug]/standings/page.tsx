"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface TeamStanding {
  teamId: string;
  name: string;
  abbreviation: string;
  group: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  pointsDiff: number;
  leaguePoints: number;
  bonusPoints: number;
  calculatedBonus: number;
  chipPoints: number;
  cbpPoints: number;
  cbpTooltip: {
    chips: { label: string; status: "available" | "used" | "pending"; points: number; gameweek?: number; opponent?: string }[];
    bps: { gameweek: number; points: number }[];
    hitPenalty: {
      penaltyGws: { gameweek: number; playerName: string; hits: number }[];
      totalDeduction: number;
    };
  };
  groupRank: number;
  zone: "playoffs" | "challenger" | "eliminated";
}

function StandingsTable({ teams, group }: { teams: TeamStanding[]; group: string }) {
  const [tooltip, setTooltip] = useState<{
    team: TeamStanding;
    x: number;
    y: number;
  } | null>(null);

  const handleMouseEnter = (e: React.MouseEvent, team: TeamStanding) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({ team, x: rect.left, y: rect.top + rect.height / 2 });
  };

  const handleMouseLeave = () => setTooltip(null);

  const handleClick = (e: React.MouseEvent, team: TeamStanding) => {
    if (tooltip?.team.teamId === team.teamId) {
      setTooltip(null);
    } else {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setTooltip({ team, x: rect.left, y: rect.top + rect.height / 2 });
    }
  };

  return (
    <>
      {tooltip && (
        <div
          className="fixed z-50 bg-slate-900 border border-white/20 rounded-lg p-3 shadow-xl w-64 text-left pointer-events-none"
          style={{
            top: Math.max(8, Math.min(tooltip.y - 120, window.innerHeight - 320)),
            left: Math.max(8, tooltip.x - 268),
          }}
        >
          <p className="text-gray-400 text-xs font-semibold mb-2 uppercase tracking-wide">CP/BP Breakdown</p>
          <div className="space-y-1 mb-2">
            {tooltip.team.cbpTooltip.chips.map((chip, i) => {
              const detail = chip.gameweek
                ? (chip.opponent ? ` vs ${chip.opponent} GW${chip.gameweek}` : ` GW${chip.gameweek}`)
                : "";
              let valueText: string;
              let valueClass: string;
              if (chip.status === "available") {
                valueText = "Available"; valueClass = "text-gray-500";
              } else if (chip.status === "pending") {
                valueText = `Pending${detail}`; valueClass = "text-yellow-400";
              } else if (chip.points > 0) {
                valueText = `+${chip.points}${detail}`; valueClass = "text-green-400 font-bold";
              } else {
                valueText = `0${detail}`;
                valueClass = "text-gray-500";
              }
              return (
                <div key={i} className="flex justify-between gap-2 text-xs">
                  <span className="text-gray-400 w-9 shrink-0 font-mono">{chip.label}</span>
                  <span className={`${valueClass} text-right`}>{valueText}</span>
                </div>
              );
            })}
          </div>
          {tooltip.team.cbpTooltip.bps.length > 0 && (
            <div className="pt-2 border-t border-white/10 mb-2">
              <p className="text-gray-500 text-xs mb-1 uppercase tracking-wide">BPS</p>
              <div className="space-y-1">
                {tooltip.team.cbpTooltip.bps.map((b, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span className="text-gray-400">GW{b.gameweek}</span>
                    <span className="text-blue-400 font-bold">+{b.points}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tooltip.team.cbpTooltip.hitPenalty.penaltyGws.length > 0 && (
            <div className="pt-2 border-t border-white/10 mb-2">
              <p className="text-gray-500 text-xs mb-1 uppercase tracking-wide">Hit Penalty</p>
              <div className="space-y-1">
                {tooltip.team.cbpTooltip.hitPenalty.penaltyGws.map((p, i) => (
                  <div key={i} className="flex justify-between gap-2 text-xs">
                    <span className="text-gray-400">GW{p.gameweek} {p.playerName} ({p.hits} hits)</span>
                    <span className="text-red-400 font-bold shrink-0">-1 pt</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="pt-2 border-t border-white/10 flex justify-between text-xs">
            <span className="text-gray-400">Total CP/BP</span>
            <span className="text-purple-300 font-bold">+{tooltip.team.cbpPoints}</span>
          </div>
          {tooltip.team.cbpTooltip.hitPenalty.totalDeduction > 0 && (
            <div className="flex justify-between text-xs mt-1">
              <span className="text-gray-400">Hit Deduction</span>
              <span className="text-red-400 font-bold">-{tooltip.team.cbpTooltip.hitPenalty.totalDeduction} pt{tooltip.team.cbpTooltip.hitPenalty.totalDeduction > 1 ? "s" : ""}</span>
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur overflow-hidden">
        <div className="bg-gradient-to-r from-purple-600/20 to-orange-500/20 px-4 py-3 border-b border-white/10">
          <h2 className="text-lg font-bold text-white">Group {group}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[500px]">
            <thead>
              <tr className="border-b border-white/10 text-xs text-gray-400">
                <th className="px-3 py-2 text-left font-medium w-10">Rank</th>
                <th className="px-2 py-2 text-left font-medium">Team</th>
                <th className="px-2 py-2 text-center font-medium w-9">MP</th>
                <th className="px-2 py-2 text-center font-medium w-8">W</th>
                <th className="px-2 py-2 text-center font-medium w-8">D</th>
                <th className="px-2 py-2 text-center font-medium w-8">L</th>
                <th className="px-2 py-2 text-center font-medium w-12" title="Chips and Bonus Points">CP/BP</th>
                <th className="px-2 py-2 text-center font-medium w-14">Pts</th>
                <th className="px-2 py-2 text-center font-medium w-16">Scores</th>
              </tr>
            </thead>
            <tbody>
              {teams.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-gray-500">
                    No teams in this group yet
                  </td>
                </tr>
              ) : (
                teams.map((team) => (
                  <tr
                    key={team.teamId}
                    className={`border-b border-white/5 transition hover:bg-white/5 ${
                      team.zone === "playoffs"
                        ? "bg-green-500/5"
                        : team.zone === "challenger"
                        ? "bg-yellow-500/5"
                        : "bg-red-500/5"
                    }`}
                  >
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                          team.zone === "playoffs"
                            ? "bg-green-500/20 text-green-400"
                            : team.zone === "challenger"
                            ? "bg-yellow-500/20 text-yellow-400"
                            : "bg-red-500/20 text-red-400"
                        }`}
                      >
                        {team.groupRank}
                      </span>
                    </td>
                    <td className="px-2 py-2 font-medium text-white leading-tight">{team.name}</td>
                    <td className="px-2 py-2 text-center text-gray-400">{team.played}</td>
                    <td className="px-2 py-2 text-center text-green-400">{team.wins}</td>
                    <td className="px-2 py-2 text-center text-gray-400">{team.draws}</td>
                    <td className="px-2 py-2 text-center text-red-400">{team.losses}</td>
                    <td
                      className="px-2 py-2 text-center text-purple-400"
                      onMouseEnter={(e) => handleMouseEnter(e, team)}
                      onMouseLeave={handleMouseLeave}
                      onClick={(e) => handleClick(e, team)}
                    >
                      <span className="cursor-help underline decoration-dotted underline-offset-2">
                        {team.cbpPoints}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center font-bold text-white">{team.leaguePoints}</td>
                    <td className="px-2 py-2 text-center text-gray-400">{team.pointsFor}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

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
    // Fetch league name
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
