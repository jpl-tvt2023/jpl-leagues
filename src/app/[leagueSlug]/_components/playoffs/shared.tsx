"use client";

import { useState, useEffect } from "react";

export interface LiveFixtureScore {
  fixtureId: string;
  gameweek: number;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  homeScore: number;
  awayScore: number;
  homePlayers: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
  awayPlayers: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
}

export interface TeamSide {
  teamId: string | null;
  name: string;
  abbr: string;
  leg1Score: number | null;
  leg2Score: number | null;
  aggregate: number | null;
}

export interface TieDisplay {
  tieId: string;
  roundName: string;
  status: string;
  gw1: number;
  gw2: number | null;
  home: TeamSide | null;
  away: TeamSide | null;
  winnerId: string | null;
  loserId: string | null;
}

export interface SurvivalDisplay {
  teamId: string;
  name: string;
  abbr: string;
  score: number;
  rank: number | null;
  advanced: boolean;
}

export interface GroupStanding {
  teamId: string;
  name: string;
  abbr: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pointsFor: number;
  leaguePoints: number;
  advanced: boolean;
}

export interface GroupData {
  name: string;
  roundPrefix: string;
  standings: GroupStanding[];
  fixtures: TieDisplay[];
}

export interface BracketData {
  mode: "tentative" | "projected" | "live";
  latestCompletedGw: number;
  teamSize?: number;
  groupStage?: { groups: GroupData[] };
  tvt: {
    ro16?: TieDisplay[];
    qf?: TieDisplay[];
    sf?: TieDisplay[];
    thirdPlace?: TieDisplay[];
    final?: TieDisplay[];
  };
  challenger: {
    c31?: TieDisplay[];
    c32?: TieDisplay[];
    c33?: SurvivalDisplay[];
    c34?: TieDisplay[];
    c35?: TieDisplay[];
    c36?: TieDisplay[];
    c37?: TieDisplay[];
    c38?: TieDisplay[];
  };
  liveScores?: Record<number, LiveFixtureScore[]>;
}

function PlayerBreakdown({
  label,
  players,
  gameweek,
}: {
  label: string;
  players: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; finalScore: number }[];
  gameweek: number;
}) {
  if (players.length === 0) return null;
  return (
    <div className="min-w-0">
      <div className="text-[10px] text-gray-400 mb-1 text-center">{label}</div>
      {players.map((p, i) => (
        <div key={i} className="flex items-center justify-between py-0.5 text-xs min-w-0">
          <div className="flex items-center gap-1 min-w-0 flex-1">
            <a
              href={`https://fantasy.premierleague.com/entry/${p.fplId}/event/${gameweek}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:text-blue-300 underline truncate"
            >
              {p.name}
            </a>
            {p.isCaptain && (
              <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-yellow-500/20 text-yellow-400">C</span>
            )}
          </div>
          <div className="text-right">
            {p.isCaptain ? (
              <span className="text-yellow-400 font-semibold">
                {p.fplScore}{p.transferHits > 0 ? ` - ${p.transferHits}` : ""} × 2 = {p.finalScore}
              </span>
            ) : (
              <span className="text-white">{p.finalScore}{p.transferHits > 0 ? ` (−${p.transferHits})` : ""}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function MatchCard({
  tie,
  compact,
  liveScores,
  isFreshlyRefreshed,
  useFullName,
}: {
  tie: TieDisplay;
  compact?: boolean;
  liveScores?: LiveFixtureScore[];
  isFreshlyRefreshed?: boolean;
  useFullName?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const is2Leg = tie.gw2 !== null;
  const isPlaceholder = (side: TeamSide | null) => !side?.teamId;

  const getLiveScoreForGW = (gwNumber: number): LiveFixtureScore | undefined => {
    if (!liveScores || !tie.home?.abbr || !tie.away?.abbr) return undefined;
    return liveScores.find((l) => {
      const homeAbbr = tie.home!.abbr;
      const awayAbbr = tie.away!.abbr;
      return (
        l.gameweek === gwNumber &&
        ((l.homeTeamAbbr === homeAbbr && l.awayTeamAbbr === awayAbbr) ||
         (l.homeTeamAbbr === awayAbbr && l.awayTeamAbbr === homeAbbr))
      );
    });
  };

  const liveScoreLeg1 = getLiveScoreForGW(tie.gw1);
  const liveScoreLeg2 = is2Leg ? getLiveScoreForGW(tie.gw2!) : undefined;

  const showLiveLeg1 = !!liveScoreLeg1;
  const showLiveLeg2 = !!liveScoreLeg2;
  const showLive = showLiveLeg1 || showLiveLeg2;

  const hasPlayerData = (liveScoreLeg1?.homePlayers?.length ?? 0) > 0 || (liveScoreLeg2?.homePlayers?.length ?? 0) > 0;
  const bothPlaceholder = isPlaceholder(tie.home) && isPlaceholder(tie.away);
  const expandable = !bothPlaceholder;

  const teamLabel = (side: TeamSide | null) => {
    if (!side) return "TBD";
    if (useFullName) return side.name || side.abbr || "TBD";
    return side.abbr || side.name || "TBD";
  };

  const teamClass = (side: TeamSide | null) => {
    if (tie.winnerId && side?.teamId && tie.winnerId === side.teamId) return "text-green-400 font-bold";
    if (isPlaceholder(side)) return "text-gray-500 italic";
    return "text-white";
  };

  const getLiveScore = (side: TeamSide | null, liveFixture: LiveFixtureScore | undefined): number | null => {
    if (!liveFixture || !side?.abbr) return null;
    if (liveFixture.homeTeamAbbr === side.abbr) return liveFixture.homeScore;
    if (liveFixture.awayTeamAbbr === side.abbr) return liveFixture.awayScore;
    return null;
  };

  const getPlayersForSide = (side: TeamSide | null, liveFixture: LiveFixtureScore | undefined) => {
    if (!liveFixture || !side?.abbr) return [];
    if (liveFixture.homeTeamAbbr === side.abbr) return liveFixture.homePlayers;
    if (liveFixture.awayTeamAbbr === side.abbr) return liveFixture.awayPlayers;
    return [];
  };

  return (
    <div
      className={`bg-slate-800/80 border rounded-lg ${compact ? "p-2" : "p-3"} text-sm ${
        showLive ? "border-green-500/30" : "border-white/10"
      } ${expandable ? "cursor-pointer hover:bg-slate-700/80 transition-colors" : ""}`}
      onClick={expandable ? () => setExpanded(!expanded) : undefined}
    >
      <div className="flex items-center justify-between text-[10px] text-gray-500 uppercase tracking-wide mb-1">
        <span>{tie.tieId} {is2Leg ? `(GW${tie.gw1}+${tie.gw2})` : `(GW${tie.gw1})`}</span>
        <div className="flex items-center gap-2">
          {showLive && (
            <span className={`flex items-center gap-1 normal-case ${
              isFreshlyRefreshed ? "text-amber-400" : "text-gray-400"
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full animate-pulse ${
                isFreshlyRefreshed ? "bg-amber-400" : "bg-gray-400"
              }`}></span>
              LIVE
            </span>
          )}
          {expandable && (
            <span className="text-gray-500 text-[10px]">{expanded ? "▲" : "▼"}</span>
          )}
        </div>
      </div>

      <div className={`flex items-center justify-between gap-2 py-1 ${teamClass(tie.home)}`}>
        <span className="truncate flex-1">{teamLabel(tie.home)}</span>
        {!isPlaceholder(tie.home) && (
          is2Leg ? (
            <div className="flex gap-2 text-xs tabular-nums">
              <span className={`w-5 text-center ${showLiveLeg1 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg1 ? getLiveScore(tie.home, liveScoreLeg1) ?? "–" : (tie.home?.leg1Score ?? "–")}
              </span>
              <span className={`w-5 text-center ${showLiveLeg2 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg2 ? getLiveScore(tie.home, liveScoreLeg2) ?? "–" : (tie.home?.leg2Score ?? "–")}
              </span>
              <span className="w-6 text-center font-bold border-l border-white/20 pl-1">
                {(() => {
                  const leg1Val = showLiveLeg1 ? (getLiveScore(tie.home, liveScoreLeg1) ?? 0) : (tie.home?.leg1Score ?? 0);
                  const leg2Val = showLiveLeg2 ? (getLiveScore(tie.home, liveScoreLeg2) ?? 0) : (tie.home?.leg2Score ?? 0);
                  return leg1Val + leg2Val;
                })()}
              </span>
            </div>
          ) : (
            <span className={`text-xs tabular-nums w-5 text-center ${showLive ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
              {showLive ? getLiveScore(tie.home, liveScoreLeg1) ?? "–" : (tie.home?.leg1Score ?? "–")}
            </span>
          )
        )}
      </div>

      <div className={`flex items-center justify-between gap-2 py-1 ${teamClass(tie.away)}`}>
        <span className="truncate flex-1">{teamLabel(tie.away)}</span>
        {!isPlaceholder(tie.away) && (
          is2Leg ? (
            <div className="flex gap-2 text-xs tabular-nums">
              <span className={`w-5 text-center ${showLiveLeg1 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg1 ? getLiveScore(tie.away, liveScoreLeg1) ?? "–" : (tie.away?.leg1Score ?? "–")}
              </span>
              <span className={`w-5 text-center ${showLiveLeg2 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg2 ? getLiveScore(tie.away, liveScoreLeg2) ?? "–" : (tie.away?.leg2Score ?? "–")}
              </span>
              <span className="w-6 text-center font-bold border-l border-white/20 pl-1">
                {(() => {
                  const leg1Val = showLiveLeg1 ? (getLiveScore(tie.away, liveScoreLeg1) ?? 0) : (tie.away?.leg1Score ?? 0);
                  const leg2Val = showLiveLeg2 ? (getLiveScore(tie.away, liveScoreLeg2) ?? 0) : (tie.away?.leg2Score ?? 0);
                  return leg1Val + leg2Val;
                })()}
              </span>
            </div>
          ) : (
            <span className={`text-xs tabular-nums w-5 text-center ${showLive ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
              {showLive ? getLiveScore(tie.away, liveScoreLeg1) ?? "–" : (tie.away?.leg1Score ?? "–")}
            </span>
          )
        )}
      </div>

      {is2Leg && !isPlaceholder(tie.home) && (
        <div className="flex justify-end text-[10px] text-gray-500 gap-2 mt-0.5">
          <span className="w-5 text-center">L1</span>
          <span className="w-5 text-center">L2</span>
          <span className="w-6 text-center pl-1">Agg</span>
        </div>
      )}

      {expanded && expandable && !hasPlayerData && (
        <div className="mt-2 pt-2 border-t border-white/10 text-center text-[11px] text-gray-400" onClick={(e) => e.stopPropagation()}>
          Player breakdown not yet available — FPL data will appear once the gameweek begins.
        </div>
      )}

      {expanded && hasPlayerData && (
        <div className="mt-2 pt-2 border-t border-white/10" onClick={(e) => e.stopPropagation()}>
          {showLiveLeg1 && liveScoreLeg1 && (liveScoreLeg1.homePlayers?.length ?? 0) > 0 && (
            <div>
              {is2Leg && <div className="text-[10px] text-gray-500 font-semibold mb-1">Leg 1 (GW{tie.gw1})</div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <PlayerBreakdown
                  label={`${tie.home?.abbr || "Home"} Players`}
                  players={getPlayersForSide(tie.home, liveScoreLeg1)}
                  gameweek={tie.gw1}
                />
                <PlayerBreakdown
                  label={`${tie.away?.abbr || "Away"} Players`}
                  players={getPlayersForSide(tie.away, liveScoreLeg1)}
                  gameweek={tie.gw1}
                />
              </div>
            </div>
          )}
          {showLiveLeg2 && liveScoreLeg2 && (liveScoreLeg2.homePlayers?.length ?? 0) > 0 && (
            <div className={showLiveLeg1 ? "mt-2" : ""}>
              <div className="text-[10px] text-gray-500 font-semibold mb-1">Leg 2 (GW{tie.gw2})</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <PlayerBreakdown
                  label={`${tie.home?.abbr || "Home"} Players`}
                  players={getPlayersForSide(tie.home, liveScoreLeg2)}
                  gameweek={tie.gw2!}
                />
                <PlayerBreakdown
                  label={`${tie.away?.abbr || "Away"} Players`}
                  players={getPlayersForSide(tie.away, liveScoreLeg2)}
                  gameweek={tie.gw2!}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RoundColumn({
  title,
  ties,
  className,
  liveScores,
  refreshingGw,
  tempLiveScores,
  onRefreshRound,
}: {
  title: string;
  ties: TieDisplay[];
  className?: string;
  liveScores?: Record<number, LiveFixtureScore[]>;
  refreshingGw?: number | null;
  tempLiveScores?: Record<number, LiveFixtureScore[]>;
  onRefreshRound?: (gw: number) => void;
}) {
  if (ties.length === 0) return null;

  const tempScores = tempLiveScores ? Object.values(tempLiveScores).flat() : [];
  const cachedScores = liveScores ? Object.values(liveScores).flat() : [];
  const mergedScores = [...tempScores, ...cachedScores];

  const roundGw = ties[0].gw1;
  const hasLiveData = mergedScores.some((s) => s.gameweek === roundGw);
  const isRefreshing = refreshingGw === roundGw;
  const isFreshlyRefreshed = (tempLiveScores ? Object.keys(tempLiveScores).map(Number) : []).includes(roundGw);

  return (
    <div className={`flex flex-col gap-3 ${className || ""}`}>
      <div className="flex items-center justify-center gap-2">
        <h3 className="text-xs font-bold text-yellow-400 uppercase tracking-wider text-center">{title}</h3>
        {hasLiveData && onRefreshRound && (
          <button
            onClick={() => onRefreshRound(roundGw)}
            disabled={isRefreshing}
            className={`text-green-400 hover:text-green-300 disabled:opacity-50 transition-all text-sm ${isRefreshing ? "animate-spin" : ""}`}
            title="Refresh live scores"
          >
            ⟳
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 justify-around flex-1">
        {ties.map((tie) => (
          <MatchCard
            key={tie.tieId}
            tie={tie}
            liveScores={mergedScores}
            isFreshlyRefreshed={isFreshlyRefreshed}
          />
        ))}
      </div>
    </div>
  );
}

export function SurvivalTable({ entries }: { entries: SurvivalDisplay[] }) {
  if (entries.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-bold text-yellow-400 uppercase tracking-wider mb-2">
        C-33 Survival (GW33) — Top 8 Advance
      </h3>
      <div className="bg-slate-800/80 border border-white/10 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-xs border-b border-white/10">
                <th className="text-left px-3 py-2 w-10">#</th>
                <th className="text-left px-3 py-2">Team</th>
                <th className="text-right px-3 py-2">Score</th>
                <th className="text-center px-3 py-2 w-16">Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={e.teamId || `placeholder-${i}`} className={`border-b border-white/5 ${e.advanced ? "bg-green-900/20" : i >= 8 ? "bg-red-900/10" : ""}`}>
                  <td className="px-3 py-2 text-gray-400">{e.rank ?? i + 1}</td>
                  <td className={`px-3 py-2 ${e.advanced ? "text-green-400 font-semibold" : "text-white"}`}>{e.abbr}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-white">{e.score || "–"}</td>
                  <td className="px-3 py-2 text-center">
                    {e.advanced ? (
                      <span className="text-green-400 text-xs">✓</span>
                    ) : e.rank && e.rank > 8 ? (
                      <span className="text-red-400 text-xs">✗</span>
                    ) : (
                      <span className="text-gray-500 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export function GroupStageView({
  groups,
  liveScores,
  refreshingGw,
  tempLiveScores,
  onRefreshRound,
  playoffStartGw,
  latestCompletedGw,
}: {
  groups: GroupData[];
  liveScores?: Record<number, LiveFixtureScore[]>;
  refreshingGw?: number | null;
  tempLiveScores?: Record<number, LiveFixtureScore[]>;
  onRefreshRound?: (gw: number) => void;
  playoffStartGw?: number;
  latestCompletedGw?: number;
}) {
  const [expandedGws, setExpandedGws] = useState<Record<string, Set<number>>>({});

  useEffect(() => {
    const currentGw = latestCompletedGw ? (latestCompletedGw < 33 ? latestCompletedGw + 1 : 33) : 31;
    const newExpanded: Record<string, Set<number>> = {};
    groups.forEach((g) => {
      newExpanded[g.roundPrefix] = new Set([currentGw]);
    });
    setExpandedGws(newExpanded);
  }, [groups, latestCompletedGw]);

  const toggleGwExpanded = (groupPrefix: string, gw: number) => {
    setExpandedGws((prev) => {
      const newState = { ...prev };
      if (!newState[groupPrefix]) newState[groupPrefix] = new Set();
      if (newState[groupPrefix].has(gw)) {
        newState[groupPrefix].delete(gw);
      } else {
        newState[groupPrefix].add(gw);
      }
      return newState;
    });
  };

  const isGwExpanded = (groupPrefix: string, gw: number) => expandedGws[groupPrefix]?.has(gw) ?? false;

  const mergedScores = [
    ...(tempLiveScores ? Object.values(tempLiveScores).flat() : []),
    ...(liveScores ? Object.values(liveScores).flat() : []),
  ];

  const champGroups = groups.filter((g) => g.roundPrefix.includes("C") && !g.roundPrefix.includes("XA") && !g.roundPrefix.includes("XB"));
  const challGroups = groups.filter((g) => g.roundPrefix.includes("X"));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gradient-to-br from-blue-900/40 to-blue-900/20 border border-blue-400/30 rounded-xl p-4">
          <p className="text-xs font-semibold text-blue-300 uppercase tracking-wider mb-2">🏆 Championship Groups</p>
          <p className="text-sm text-blue-100 font-medium mb-1">Top 2 advance to Championship Knockouts</p>
          <p className="text-xs text-blue-200">3rd-4th join Challenger Quarter-Finals</p>
        </div>
        <div className="bg-gradient-to-br from-purple-900/40 to-purple-900/20 border border-purple-400/30 rounded-xl p-4">
          <p className="text-xs font-semibold text-purple-300 uppercase tracking-wider mb-2">⚡ Challenger Groups</p>
          <p className="text-sm text-purple-100 font-medium mb-1">Top 2 play Challenger Quarter-Finals</p>
          <p className="text-xs text-purple-200">3rd-4th are eliminated</p>
        </div>
      </div>

      {(champGroups.length > 0 || challGroups.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {champGroups.map((group) => {
            const groupLetter = group.roundPrefix.includes("CA") ? "A" : "B";
            return (
              <div key={group.roundPrefix} className="bg-slate-800/40 border border-blue-500/20 rounded-xl overflow-hidden shadow-lg hover:shadow-blue-500/10 transition-shadow">
                <div className="bg-gradient-to-r from-blue-900/60 to-blue-800/40 border-b border-blue-500/20 px-4 py-3">
                  <p className="text-xs text-blue-400 uppercase tracking-wider font-semibold mb-1">Championship</p>
                  <h3 className="text-base font-bold text-blue-200 uppercase tracking-wider">Group {groupLetter}</h3>
                </div>
                <div className="p-3">
                  <div className="mb-4 rounded-lg overflow-x-auto border border-blue-500/10">
                    <table className="w-full text-xs min-w-[300px]">
                      <thead>
                        <tr className="text-blue-300 bg-slate-900/50 border-b border-blue-500/10">
                          <th className="text-left px-2 py-1.5">Pos</th>
                          <th className="text-left px-2 py-1.5">Team</th>
                          <th className="text-center px-1 py-1.5">P</th>
                          <th className="text-center px-1 py-1.5">W</th>
                          <th className="text-center px-1 py-1.5">D</th>
                          <th className="text-center px-1 py-1.5">L</th>
                          <th className="text-right px-2 py-1.5">Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.standings.map((team, i) => (
                          <tr
                            key={team.teamId}
                            className={`border-b border-blue-500/10 transition-colors ${team.advanced ? "bg-green-900/25 hover:bg-green-900/35" : i >= 2 ? "bg-purple-900/15 hover:bg-purple-900/25" : "hover:bg-slate-700/30"}`}
                          >
                            <td className="px-2 py-1.5 text-blue-400 font-semibold text-xs">{i + 1}</td>
                            <td className={`px-2 py-1.5 font-semibold text-xs ${team.advanced ? "text-green-300" : i >= 2 ? "text-purple-300" : "text-white"}`}>
                              <span className="truncate block">{team.name}</span>
                            </td>
                            <td className="text-center text-gray-300 text-xs">{team.played}</td>
                            <td className="text-center text-gray-300 text-xs">{team.won}</td>
                            <td className="text-center text-gray-300 text-xs">{team.drawn}</td>
                            <td className="text-center text-gray-300 text-xs">{team.lost}</td>
                            <td className="text-right px-2 py-1.5 text-white font-bold tabular-nums text-xs">{team.leaguePoints}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-blue-300/60 uppercase tracking-wider font-semibold">Matches</p>
                    {[31, 32, 33].map((gw) => {
                      const gwFixtures = group.fixtures.filter((f) => f.gw1 === (playoffStartGw ? playoffStartGw + (gw - 31) : gw));
                      if (gwFixtures.length === 0) return null;
                      const isExpanded = isGwExpanded(group.roundPrefix, gw);
                      return (
                        <div key={gw}>
                          <button
                            onClick={() => toggleGwExpanded(group.roundPrefix, gw)}
                            className="w-full flex items-center justify-between text-xs font-semibold text-blue-300 hover:text-blue-200 transition py-1 px-1.5 rounded hover:bg-blue-500/10"
                          >
                            <div className="flex items-center gap-2">
                              <span>GW{gw}</span>
                              {mergedScores.some((s) => s.gameweek === gw) && onRefreshRound && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); onRefreshRound(gw); }}
                                  disabled={refreshingGw === gw}
                                  className={`text-green-400 hover:text-green-300 disabled:opacity-50 transition-all text-xs ${refreshingGw === gw ? "animate-spin" : ""}`}
                                  title="Refresh live scores"
                                >
                                  ⟳
                                </button>
                              )}
                            </div>
                            <span className="text-blue-500/60">{isExpanded ? "▼" : "▶"}</span>
                          </button>
                          {isExpanded && (
                            <div className="space-y-1 mt-1">
                              {gwFixtures.map((tie) => (
                                <MatchCard key={tie.tieId} tie={tie} compact liveScores={mergedScores} useFullName={true} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}

          {challGroups.map((group) => {
            const groupLetter = group.roundPrefix.includes("XA") ? "A" : "B";
            return (
              <div key={group.roundPrefix} className="bg-slate-800/40 border border-purple-500/20 rounded-xl overflow-hidden shadow-lg hover:shadow-purple-500/10 transition-shadow">
                <div className="bg-gradient-to-r from-purple-900/60 to-purple-800/40 border-b border-purple-500/20 px-4 py-3">
                  <p className="text-xs text-purple-400 uppercase tracking-wider font-semibold mb-1">Challenger</p>
                  <h3 className="text-base font-bold text-purple-200 uppercase tracking-wider">Group {groupLetter}</h3>
                </div>
                <div className="p-3">
                  <div className="mb-4 rounded-lg overflow-x-auto border border-purple-500/10">
                    <table className="w-full text-xs min-w-[300px]">
                      <thead>
                        <tr className="text-purple-300 bg-slate-900/50 border-b border-purple-500/10">
                          <th className="text-left px-2 py-1.5">Pos</th>
                          <th className="text-left px-2 py-1.5">Team</th>
                          <th className="text-center px-1 py-1.5">P</th>
                          <th className="text-center px-1 py-1.5">W</th>
                          <th className="text-center px-1 py-1.5">D</th>
                          <th className="text-center px-1 py-1.5">L</th>
                          <th className="text-right px-2 py-1.5">Pts</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.standings.map((team, i) => (
                          <tr
                            key={team.teamId}
                            className={`border-b border-purple-500/10 transition-colors ${team.advanced ? "bg-purple-900/30 hover:bg-purple-900/40" : "hover:bg-slate-700/30"}`}
                          >
                            <td className="px-2 py-1.5 text-purple-400 font-semibold text-xs">{i + 1}</td>
                            <td className={`px-2 py-1.5 font-semibold text-xs ${team.advanced ? "text-purple-200" : "text-white"}`}>
                              <span className="truncate block">{team.name}</span>
                            </td>
                            <td className="text-center text-gray-300 text-xs">{team.played}</td>
                            <td className="text-center text-gray-300 text-xs">{team.won}</td>
                            <td className="text-center text-gray-300 text-xs">{team.drawn}</td>
                            <td className="text-center text-gray-300 text-xs">{team.lost}</td>
                            <td className="text-right px-2 py-1.5 text-white font-bold tabular-nums text-xs">{team.leaguePoints}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-purple-300/60 uppercase tracking-wider font-semibold">Matches</p>
                    {[31, 32, 33].map((gw) => {
                      const gwFixtures = group.fixtures.filter((f) => f.gw1 === (playoffStartGw ? playoffStartGw + (gw - 31) : gw));
                      if (gwFixtures.length === 0) return null;
                      const isExpanded = isGwExpanded(group.roundPrefix, gw);
                      return (
                        <div key={gw}>
                          <button
                            onClick={() => toggleGwExpanded(group.roundPrefix, gw)}
                            className="w-full flex items-center justify-between text-xs font-semibold text-purple-300 hover:text-purple-200 transition py-1 px-1.5 rounded hover:bg-purple-500/10"
                          >
                            <div className="flex items-center gap-2">
                              <span>GW{gw}</span>
                              {mergedScores.some((s) => s.gameweek === gw) && onRefreshRound && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); onRefreshRound(gw); }}
                                  disabled={refreshingGw === gw}
                                  className={`text-green-400 hover:text-green-300 disabled:opacity-50 transition-all text-xs ${refreshingGw === gw ? "animate-spin" : ""}`}
                                  title="Refresh live scores"
                                >
                                  ⟳
                                </button>
                              )}
                            </div>
                            <span className="text-purple-500/60">{isExpanded ? "▼" : "▶"}</span>
                          </button>
                          {isExpanded && (
                            <div className="space-y-1 mt-1">
                              {gwFixtures.map((tie) => (
                                <MatchCard key={tie.tieId} tie={tie} compact liveScores={mergedScores} useFullName={true} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function usePlayoffsBracket(leagueSlug: string) {
  const [data, setData] = useState<BracketData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<number | null>(null);
  const [tempLiveScores, setTempLiveScores] = useState<Record<number, LiveFixtureScore[]>>({});

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch(`/api/playoffs/bracket?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (res.ok) {
          const bracket = await res.json();
          setData(bracket);
          if (bracket.latestCompletedGw >= 30) {
            for (let gw = bracket.latestCompletedGw; gw <= Math.min(bracket.latestCompletedGw + 1, 38); gw++) {
              if (gw < 31) continue;
              try {
                const liveRes = await fetch(`/api/fixtures/live?gameweek=${gw}&leagueSlug=${encodeURIComponent(leagueSlug)}`);
                if (liveRes.ok) {
                  const liveData = await liveRes.json();
                  if (liveData.isLive && liveData.fixtures?.length > 0) break;
                }
              } catch {}
            }
          }
        }
      } catch (err) {
        console.error("Failed to fetch bracket:", err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchData();
  }, [leagueSlug]);

  const handleRefreshRound = async (gwNumber: number) => {
    setRefreshing(gwNumber);
    try {
      const res = await fetch(`/api/fixtures/live/refresh?gameweek=${gwNumber}&leagueSlug=${encodeURIComponent(leagueSlug)}`);
      if (res.ok) {
        const freshData = await res.json();
        setTempLiveScores((prev) => ({ ...prev, [gwNumber]: freshData.fixtures || [] }));
      }
    } catch (err) {
      console.error("Refresh failed:", err);
    } finally {
      setRefreshing(null);
    }
  };

  return { data, isLoading, refreshing, tempLiveScores, handleRefreshRound };
}
