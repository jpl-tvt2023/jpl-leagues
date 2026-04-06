"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

interface CupGroupStanding {
  teamId: string;
  name: string;
  abbreviation: string;
  wins: number;
  draws: number;
  losses: number;
  goalFor: number;
  goalAgainst: number;
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

interface Fixture {
  id: string;
  homeTeam: { name: string; abbreviation: string };
  awayTeam: { name: string; abbreviation: string };
  competitionType?: string | null;
  gameweek: { number: number; deadline: Date };
  result?: {
    homeScore: number;
    awayScore: number;
  } | null;
}

interface GameweekFixtures {
  [key: number]: Fixture[];
}

interface TieDisplay {
  tieId: string;
  roundName: string;
  status: string;
  home?: { teamId: string; teamName: string; teamAbbr: string; score?: number };
  away?: { teamId: string; teamName: string; teamAbbr: string; score?: number };
  winnerId?: string | null;
}

interface BracketData {
  tvt?: { qf?: TieDisplay[]; sf?: TieDisplay[]; final?: TieDisplay[] };
}

export default function UCLPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [leagueName, setLeagueName] = useState<string>("");
  const [cupStandings, setCupStandings] = useState<CupStandingsData>({});
  const [fixtures, setFixtures] = useState<GameweekFixtures>({});
  const [availableGWs, setAvailableGWs] = useState<number[]>([]);
  const [selectedGW, setSelectedGW] = useState<number | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [bracket, setBracket] = useState<BracketData>({});

  // Fetch league name
  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => {
        const league = (data.leagues || []).find((l: { slug: string; name: string }) => l.slug === leagueSlug);
        if (league) setLeagueName(league.name);
      })
      .catch(() => {});
  }, [leagueSlug]);

  // Check auth
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => {
        const ok = r.ok;
        return r.json().then((data) => ({ ok, data }));
      })
      .then(({ ok, data }) => setIsLoggedIn(ok && data.authenticated && data.type === "team"))
      .catch(() => setIsLoggedIn(false));
  }, []);

  // Fetch cup standings, fixtures, and bracket
  useEffect(() => {
    if (!leagueSlug) return;
    setIsLoading(true);

    Promise.all([
      fetch(`/api/leagues`)
        .then((r) => r.json())
        .then((data) => {
          const league = (data.leagues || []).find((l: { slug: string }) => l.slug === leagueSlug);
          return league?.id;
        }),
    ])
      .then(async ([leagueId]) => {
        // Fetch cup standings
        const cupRes = await fetch(`/api/triple-crown/cup-standings?leagueId=${leagueId}`);
        const cupData = cupRes.ok ? await cupRes.json() : {};
        setCupStandings(cupData);

        // Fetch cup fixtures
        const fixturesRes = await fetch(`/api/fixtures?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        const fixturesData = await fixturesRes.json();
        const allFixtures = fixturesData.fixtures || {};

        // Filter to cup-group fixtures only (even GWs 6-24)
        const cupGWs = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24];
        const cupFixtures: GameweekFixtures = {};
        for (const gw of cupGWs) {
          if (allFixtures[gw]) {
            cupFixtures[gw] = allFixtures[gw].filter(
              (f: Fixture) => f.competitionType === "cup-group"
            );
          }
        }
        setFixtures(cupFixtures);
        setAvailableGWs(cupGWs.filter((gw) => cupFixtures[gw]?.length > 0));

        if (cupGWs.length > 0 && cupFixtures[cupGWs[0]]?.length > 0) {
          setSelectedGW(cupGWs[0]);
        }

        // Fetch bracket
        const bracketRes = await fetch(`/api/playoffs/bracket?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        const bracketData = bracketRes.ok ? await bracketRes.json() : {};
        setBracket(bracketData);
      })
      .catch((err) => {
        console.error("Error fetching UCL data:", err);
        setError("Failed to load UCL data");
      })
      .finally(() => setIsLoading(false));
  }, [leagueSlug]);

  if (isLoading) return <LoadingScreen variant="fixtures" fullScreen />;

  const groupOrder = ["A", "B", "C", "D"];
  const selectedFixtures = selectedGW ? (fixtures[selectedGW] || []) : [];

  // Extract UCL ties (QF, SF, Final)
  const uclQF = bracket.tvt?.qf || [];
  const uclSF = bracket.tvt?.sf || [];
  const uclFinal = bracket.tvt?.final || [];

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
            Standings
          </Link>
          <Link href={`/${leagueSlug}/fixtures`} className="text-gray-300 hover:text-white transition">
            PL Fixtures
          </Link>
          <Link href={`/${leagueSlug}/ucl`} className="text-yellow-400 font-semibold transition">
            UCL
          </Link>
          <Link href={`/${leagueSlug}/europa`} className="text-gray-300 hover:text-white transition">
            Europa
          </Link>
          <Link href={`/${leagueSlug}/winners`} className="text-gray-300 hover:text-white transition">
            Winners
          </Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">
            Rules
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">UEFA Champions League</h1>
          <p className="text-gray-400">Cup group stage and knockout tournament</p>
        </div>

        {error && <div className="text-center text-red-400 py-12">{error}</div>}

        {/* Cup Group Standings */}
        <div className="mb-12">
          <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
            <span className="h-4 w-4 rounded-full bg-blue-500"></span>
            Cup Group Standings (GW1-24)
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {groupOrder.map((groupLetter) => {
              const groupKey = `Cup-${groupLetter}`;
              const group = cupStandings[groupKey];
              if (!group) return null;

              return (
                <div key={groupLetter} className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
                  <h3 className="text-lg font-bold text-white mb-4">Group {groupLetter}</h3>
                  <div className="space-y-2">
                    {group.standings.map((team, idx) => {
                      const isUCL = idx < 2;
                      const bgClass = isUCL
                        ? "bg-blue-500/10 border-l-2 border-blue-500"
                        : "bg-white/5";

                      return (
                        <div key={team.teamId} className={`p-3 rounded ${bgClass} flex items-center justify-between text-sm`}>
                          <div className="flex items-center gap-3 flex-1">
                            <span className="font-bold text-gray-400 w-6">{idx + 1}</span>
                            <span className="text-white font-semibold">{team.name}</span>
                          </div>
                          <div className="flex items-center gap-4 text-gray-300 text-xs">
                            <span>{team.wins}W {team.draws}D {team.losses}L</span>
                            <span className="font-bold text-white">{team.cupGroupPoints} pts</span>
                            {isUCL && <span className="text-blue-400 font-semibold text-[10px]">UCL</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-blue-400 mt-3">✓ Top 2 qualify for UCL knockouts</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Cup Fixtures */}
        {availableGWs.length > 0 && (
          <div className="mb-12">
            <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
              <span className="h-4 w-4 rounded-full bg-cyan-500"></span>
              Cup Group Fixtures
            </h2>

            <div className="flex items-center justify-center gap-4 mb-6">
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
                className="bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-white font-semibold"
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

            <div className="space-y-3">
              {selectedFixtures.length > 0 ? (
                selectedFixtures.map((fixture) => (
                  <div key={fixture.id} className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 text-left">
                        <div className="font-semibold text-white">{fixture.homeTeam.name}</div>
                      </div>
                      <div className="flex items-center gap-2 px-3">
                        {fixture.result ? (
                          <>
                            <span className="text-lg font-bold text-green-400">{fixture.result.homeScore}</span>
                            <span className="text-gray-500">-</span>
                            <span className="text-lg font-bold text-green-400">{fixture.result.awayScore}</span>
                          </>
                        ) : (
                          <span className="text-gray-500 font-medium text-sm">VS</span>
                        )}
                      </div>
                      <div className="flex-1 text-right">
                        <div className="font-semibold text-white">{fixture.awayTeam.name}</div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center text-gray-400 py-8">No fixtures</div>
              )}
            </div>
          </div>
        )}

        {/* UCL Knockout Bracket */}
        {(uclQF.length > 0 || uclSF.length > 0 || uclFinal.length > 0) && (
          <div className="mb-12">
            <h2 className="text-2xl font-bold text-white mb-6 flex items-center gap-2">
              <span className="h-4 w-4 rounded-full bg-purple-500"></span>
              UCL Knockout Stage
            </h2>

            {/* Quarterfinals */}
            {uclQF.length > 0 && (
              <div className="mb-8">
                <h3 className="text-lg font-bold text-gray-300 mb-4">Quarterfinals</h3>
                <div className="space-y-3">
                  {uclQF.map((tie) => (
                    <div key={tie.tieId} className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 text-left">
                          <div className="font-semibold text-white">{tie.home?.teamName || "TBD"}</div>
                        </div>
                        <div className="flex items-center gap-1 px-2 text-sm">
                          {tie.home?.score !== undefined ? (
                            <>
                              <span className="font-bold text-white">{tie.home.score}</span>
                            </>
                          ) : (
                            <span className="text-gray-500">-</span>
                          )}
                        </div>
                        <div className="flex-1 text-right">
                          <div className="font-semibold text-white">{tie.away?.teamName || "TBD"}</div>
                        </div>
                      </div>
                      {tie.winnerId && (
                        <div className="text-xs text-green-400 mt-2">✓ Winner advances</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Semifinals */}
            {uclSF.length > 0 && (
              <div className="mb-8">
                <h3 className="text-lg font-bold text-gray-300 mb-4">Semifinals</h3>
                <div className="space-y-3">
                  {uclSF.map((tie) => (
                    <div key={tie.tieId} className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 text-left">
                          <div className="font-semibold text-white">{tie.home?.teamName || "TBD"}</div>
                        </div>
                        <div className="flex items-center gap-1 px-2 text-sm">
                          {tie.home?.score !== undefined ? (
                            <>
                              <span className="font-bold text-white">{tie.home.score}</span>
                            </>
                          ) : (
                            <span className="text-gray-500">-</span>
                          )}
                        </div>
                        <div className="flex-1 text-right">
                          <div className="font-semibold text-white">{tie.away?.teamName || "TBD"}</div>
                        </div>
                      </div>
                      {tie.winnerId && (
                        <div className="text-xs text-green-400 mt-2">✓ Winner advances to final</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Final */}
            {uclFinal.length > 0 && (
              <div>
                <h3 className="text-lg font-bold text-gray-300 mb-4">Final</h3>
                <div className="space-y-3">
                  {uclFinal.map((tie) => (
                    <div
                      key={tie.tieId}
                      className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 backdrop-blur"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 text-left">
                          <div className="font-semibold text-white">{tie.home?.teamName || "TBD"}</div>
                        </div>
                        <div className="flex items-center gap-1 px-2 text-sm">
                          {tie.home?.score !== undefined ? (
                            <>
                              <span className="font-bold text-yellow-400">{tie.home.score}</span>
                            </>
                          ) : (
                            <span className="text-gray-500">-</span>
                          )}
                        </div>
                        <div className="flex-1 text-right">
                          <div className="font-semibold text-white">{tie.away?.teamName || "TBD"}</div>
                        </div>
                      </div>
                      {tie.winnerId && (
                        <div className="text-xs text-yellow-400 font-semibold mt-2">🏆 UCL CHAMPION</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
