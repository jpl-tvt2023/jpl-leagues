"use client";

import { useState, useEffect, useMemo, Fragment } from "react";

export interface LiveFixtureScore {
  fixtureId: string;
  gameweek: number;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  homePlayers: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; isTempCaptain?: boolean; finalScore: number }[];
  awayPlayers: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; isTempCaptain?: boolean; finalScore: number }[];
}

export interface TeamSide {
  teamId: string | null;
  name: string;
  seedLabel?: string | null;
  leg1Score: number | null;
  leg2Score: number | null;
  leg3Score?: number | null;
  aggregate: number | null;
}

export interface TieDisplay {
  tieId: string;
  roundName: string;
  status: string;
  gw1: number;
  gw2: number | null;
  gw3?: number | null;
  home: TeamSide | null;
  away: TeamSide | null;
  winnerId: string | null;
  loserId: string | null;
}

export interface SurvivalPlayerScore {
  name: string;
  fplId: string;
  fplScore: number;
  transferHits: number;
  isCaptain: boolean;
  isTempCaptain?: boolean;
  finalScore: number;
}

export interface SurvivalDisplay {
  teamId: string;
  name: string;
  score: number;
  rank: number | null;
  advanced: boolean;
  playerScores?: SurvivalPlayerScore[] | null;
}

export interface GroupStanding {
  teamId: string;
  name: string;
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

// Renders the player's score formula consistently across all fixture/playoff cards.
// Captain: `{net} × 2 = {final}` and a trailing `(−{hits} hit applied)` note when hits > 0.
// Non-captain: bare `{final}`, with `(−{hits} hit applied)` when hits > 0.
export function PlayerScoreFormula({
  fplScore,
  transferHits,
  finalScore,
  isCaptain,
  isTempCaptain,
  captainColorClass,
  nonCaptainColorClass,
}: {
  fplScore: number;
  transferHits: number;
  finalScore: number;
  isCaptain: boolean;
  isTempCaptain?: boolean;
  captainColorClass?: string;
  nonCaptainColorClass?: string;
}) {
  const hitNote = transferHits > 0
    ? <div className="text-gray-400 font-normal text-[10px] leading-tight">(−{transferHits} hit applied)</div>
    : null;
  if (isCaptain) {
    const net = fplScore - transferHits;
    const colour = captainColorClass ?? (isTempCaptain ? "text-amber-400" : "text-yellow-400");
    return (
      <div className="inline-flex flex-col items-end leading-tight">
        <span className={`${colour} font-semibold`}>{net} × 2 = {finalScore}</span>
        {hitNote}
      </div>
    );
  }
  return (
    <div className="inline-flex flex-col items-end leading-tight">
      <span className={nonCaptainColorClass ?? "text-white"}>{finalScore}</span>
      {hitNote}
    </div>
  );
}

function PlayerBreakdown({
  label,
  players,
  gameweek,
}: {
  label: string;
  players: { name: string; fplId: string; fplScore: number; transferHits: number; isCaptain: boolean; isTempCaptain?: boolean; finalScore: number }[];
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
            {p.isCaptain && p.isTempCaptain && (
              <span
                className="px-1 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-400 shrink-0"
                title="Auto-assigned: lowest current scorer. Locks at GW close unless admin overrides."
              >
                C*
              </span>
            )}
            {p.isCaptain && !p.isTempCaptain && (
              <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-yellow-500/20 text-yellow-400 shrink-0">C</span>
            )}
          </div>
          <div className="text-right shrink-0 ml-2 whitespace-nowrap">
            <PlayerScoreFormula
              fplScore={p.fplScore}
              transferHits={p.transferHits}
              finalScore={p.finalScore}
              isCaptain={p.isCaptain}
              isTempCaptain={p.isTempCaptain}
            />
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
}: {
  tie: TieDisplay;
  compact?: boolean;
  liveScores?: LiveFixtureScore[];
  isFreshlyRefreshed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const is3Leg = (tie.gw3 ?? null) !== null;
  const is2Leg = tie.gw2 !== null && !is3Leg;
  const isPlaceholder = (side: TeamSide | null) => !side?.teamId;

  const getLiveScoreForGW = (gwNumber: number): LiveFixtureScore | undefined => {
    if (!liveScores || !tie.home?.teamId || !tie.away?.teamId) return undefined;
    return liveScores.find((l) => {
      const homeId = tie.home!.teamId!;
      const awayId = tie.away!.teamId!;
      return (
        l.gameweek === gwNumber &&
        ((l.homeTeamId === homeId && l.awayTeamId === awayId) ||
         (l.homeTeamId === awayId && l.awayTeamId === homeId))
      );
    });
  };

  const liveScoreLeg1 = getLiveScoreForGW(tie.gw1);
  const liveScoreLeg2 = (is2Leg || is3Leg) ? getLiveScoreForGW(tie.gw2!) : undefined;
  const liveScoreLeg3 = is3Leg ? getLiveScoreForGW(tie.gw3!) : undefined;

  const showLiveLeg1 = !!liveScoreLeg1;
  const showLiveLeg2 = !!liveScoreLeg2;
  const showLiveLeg3 = !!liveScoreLeg3;
  const showLive = showLiveLeg1 || showLiveLeg2 || showLiveLeg3;

  const hasPlayerData = (liveScoreLeg1?.homePlayers?.length ?? 0) > 0 || (liveScoreLeg2?.homePlayers?.length ?? 0) > 0 || (liveScoreLeg3?.homePlayers?.length ?? 0) > 0;
  const bothPlaceholder = isPlaceholder(tie.home) && isPlaceholder(tie.away);
  const expandable = !bothPlaceholder;

  const teamLabel = (side: TeamSide | null) => {
    if (!side) return "TBD";
    return side.name || "TBD";
  };

  const teamClass = (side: TeamSide | null) => {
    if (tie.winnerId && side?.teamId && tie.winnerId === side.teamId) return "text-green-400 font-bold";
    if (isPlaceholder(side)) return "text-gray-500 italic";
    return "text-white";
  };

  const getLiveScore = (side: TeamSide | null, liveFixture: LiveFixtureScore | undefined): number | null => {
    if (!liveFixture || !side?.teamId) return null;
    if (liveFixture.homeTeamId === side.teamId) return liveFixture.homeScore;
    if (liveFixture.awayTeamId === side.teamId) return liveFixture.awayScore;
    return null;
  };

  const getPlayersForSide = (side: TeamSide | null, liveFixture: LiveFixtureScore | undefined) => {
    if (!liveFixture || !side?.teamId) return [];
    if (liveFixture.homeTeamId === side.teamId) return liveFixture.homePlayers;
    if (liveFixture.awayTeamId === side.teamId) return liveFixture.awayPlayers;
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
        <span>{tie.tieId} {is3Leg ? `(GW${tie.gw1}+${tie.gw2}+${tie.gw3})` : is2Leg ? `(GW${tie.gw1}+${tie.gw2})` : `(GW${tie.gw1})`}</span>
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
        <span className="truncate flex-1">
          <span className="block truncate">{teamLabel(tie.home)}</span>
          {tie.home?.seedLabel && tie.home?.teamId && (
            <span className="block text-[10px] text-gray-500 normal-case font-normal">{tie.home.seedLabel}</span>
          )}
        </span>
        {!isPlaceholder(tie.home) && (
          is3Leg ? (
            <div className="flex gap-2 text-xs tabular-nums">
              <span className={`w-5 text-center ${showLiveLeg1 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg1 ? getLiveScore(tie.home, liveScoreLeg1) ?? "–" : (tie.home?.leg1Score ?? "–")}
              </span>
              <span className={`w-5 text-center ${showLiveLeg2 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg2 ? getLiveScore(tie.home, liveScoreLeg2) ?? "–" : (tie.home?.leg2Score ?? "–")}
              </span>
              <span className={`w-5 text-center ${showLiveLeg3 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg3 ? getLiveScore(tie.home, liveScoreLeg3) ?? "–" : (tie.home?.leg3Score ?? "–")}
              </span>
              <span className="w-6 text-center font-bold border-l border-white/20 pl-1">
                {(() => {
                  const leg1Val = showLiveLeg1 ? (getLiveScore(tie.home, liveScoreLeg1) ?? 0) : (tie.home?.leg1Score ?? 0);
                  const leg2Val = showLiveLeg2 ? (getLiveScore(tie.home, liveScoreLeg2) ?? 0) : (tie.home?.leg2Score ?? 0);
                  const leg3Val = showLiveLeg3 ? (getLiveScore(tie.home, liveScoreLeg3) ?? 0) : (tie.home?.leg3Score ?? 0);
                  return leg1Val + leg2Val + leg3Val;
                })()}
              </span>
            </div>
          ) : is2Leg ? (
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
        <span className="truncate flex-1">
          <span className="block truncate">{teamLabel(tie.away)}</span>
          {tie.away?.seedLabel && tie.away?.teamId && (
            <span className="block text-[10px] text-gray-500 normal-case font-normal">{tie.away.seedLabel}</span>
          )}
        </span>
        {!isPlaceholder(tie.away) && (
          is3Leg ? (
            <div className="flex gap-2 text-xs tabular-nums">
              <span className={`w-5 text-center ${showLiveLeg1 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg1 ? getLiveScore(tie.away, liveScoreLeg1) ?? "–" : (tie.away?.leg1Score ?? "–")}
              </span>
              <span className={`w-5 text-center ${showLiveLeg2 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg2 ? getLiveScore(tie.away, liveScoreLeg2) ?? "–" : (tie.away?.leg2Score ?? "–")}
              </span>
              <span className={`w-5 text-center ${showLiveLeg3 ? (isFreshlyRefreshed ? "text-amber-400 animate-pulse" : "text-white") : ""}`}>
                {showLiveLeg3 ? getLiveScore(tie.away, liveScoreLeg3) ?? "–" : (tie.away?.leg3Score ?? "–")}
              </span>
              <span className="w-6 text-center font-bold border-l border-white/20 pl-1">
                {(() => {
                  const leg1Val = showLiveLeg1 ? (getLiveScore(tie.away, liveScoreLeg1) ?? 0) : (tie.away?.leg1Score ?? 0);
                  const leg2Val = showLiveLeg2 ? (getLiveScore(tie.away, liveScoreLeg2) ?? 0) : (tie.away?.leg2Score ?? 0);
                  const leg3Val = showLiveLeg3 ? (getLiveScore(tie.away, liveScoreLeg3) ?? 0) : (tie.away?.leg3Score ?? 0);
                  return leg1Val + leg2Val + leg3Val;
                })()}
              </span>
            </div>
          ) : is2Leg ? (
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

      {is3Leg && !isPlaceholder(tie.home) && (
        <div className="flex justify-end text-[10px] text-gray-500 gap-2 mt-0.5">
          <span className="w-5 text-center">L1</span>
          <span className="w-5 text-center">L2</span>
          <span className="w-5 text-center">L3</span>
          <span className="w-6 text-center pl-1">Agg</span>
        </div>
      )}

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
                  label={`${tie.home?.name || "Home"} Players`}
                  players={getPlayersForSide(tie.home, liveScoreLeg1)}
                  gameweek={tie.gw1}
                />
                <PlayerBreakdown
                  label={`${tie.away?.name || "Away"} Players`}
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
                  label={`${tie.home?.name || "Home"} Players`}
                  players={getPlayersForSide(tie.home, liveScoreLeg2)}
                  gameweek={tie.gw2!}
                />
                <PlayerBreakdown
                  label={`${tie.away?.name || "Away"} Players`}
                  players={getPlayersForSide(tie.away, liveScoreLeg2)}
                  gameweek={tie.gw2!}
                />
              </div>
            </div>
          )}
          {showLiveLeg3 && liveScoreLeg3 && (liveScoreLeg3.homePlayers?.length ?? 0) > 0 && (
            <div className={(showLiveLeg1 || showLiveLeg2) ? "mt-2" : ""}>
              <div className="text-[10px] text-gray-500 font-semibold mb-1">Leg 3 (GW{tie.gw3})</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <PlayerBreakdown
                  label={`${tie.home?.name || "Home"} Players`}
                  players={getPlayersForSide(tie.home, liveScoreLeg3)}
                  gameweek={tie.gw3!}
                />
                <PlayerBreakdown
                  label={`${tie.away?.name || "Away"} Players`}
                  players={getPlayersForSide(tie.away, liveScoreLeg3)}
                  gameweek={tie.gw3!}
                />
              </div>
            </div>
          )}
          {[liveScoreLeg1, liveScoreLeg2, liveScoreLeg3].some(s => s && [...(s.homePlayers ?? []), ...(s.awayPlayers ?? [])].some(p => p.isTempCaptain)) && (
            <div className="mt-2 text-[10px] text-amber-400/70">
              C* = auto-assigned temp captain (lowest scorer)
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

  const roundGws = Array.from(new Set(
    ties.flatMap(t => [t.gw1, t.gw2, t.gw3].filter((x): x is number => x != null))
  ));
  const hasLiveData = mergedScores.some((s) => roundGws.includes(s.gameweek));
  const isRefreshing = refreshingGw != null && roundGws.includes(refreshingGw);
  const refreshedKeys = tempLiveScores ? Object.keys(tempLiveScores).map(Number) : [];
  const isFreshlyRefreshed = roundGws.some(gw => refreshedKeys.includes(gw));

  return (
    <div className={`flex flex-col gap-3 ${className || ""}`}>
      <div className="flex items-center justify-center gap-2">
        <h3 className="text-xs font-bold text-yellow-400 uppercase tracking-wider text-center">{title}</h3>
        {hasLiveData && onRefreshRound && (
          <button
            onClick={() => roundGws.forEach(gw => onRefreshRound(gw))}
            disabled={isRefreshing}
            className={`text-green-400 hover:text-green-300 disabled:opacity-50 transition-all text-sm ${isRefreshing ? "animate-spin" : ""}`}
            title="Refresh live scores"
          >
            ⟳
          </button>
        )}
      </div>
      <div className="flex flex-col gap-3 sm:gap-4 justify-around flex-1">
        {ties.map((tie) => (
          <MatchCard key={tie.tieId} tie={tie} liveScores={mergedScores} isFreshlyRefreshed={isFreshlyRefreshed} />
        ))}
      </div>
    </div>
  );
}

export function SurvivalTable({
  entries,
  onRefresh,
  isRefreshing,
}: {
  entries: SurvivalDisplay[];
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  if (entries.length === 0) return null;
  // Render in descending score order so users see leaders first (also matches the
  // post-Advance ranked order, since rank 1 = highest score).
  const sorted = [...entries].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const hasAnyScore = sorted.some(e => (e.score ?? 0) > 0);
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-bold text-yellow-400 uppercase tracking-wider">
          C-33 Survival (GW33) — Top 8 Advance
        </h3>
        {hasAnyScore && onRefresh && (
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className={`text-green-400 hover:text-green-300 disabled:opacity-50 transition-all text-sm ${isRefreshing ? "animate-spin" : ""}`}
            title="Refresh live scores"
          >
            ⟳
          </button>
        )}
      </div>
      <div className="bg-slate-800/80 border border-white/10 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-400 text-[10px] border-b border-white/10">
              <th className="text-left px-2 py-1.5 w-6">#</th>
              <th className="text-left px-2 py-1.5">Team</th>
              <th className="text-right px-2 py-1.5">Score</th>
              <th className="w-4 px-1 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, i) => {
              const isAdvanced = e.advanced;
              const isEliminated = e.rank != null && e.rank > 8;
              const rowTint = isAdvanced ? "bg-green-900/20" : isEliminated ? "bg-red-900/10" : "";
              const expandable = !!(e.playerScores && e.playerScores.length > 0);
              const isExpanded = expandable && expandedTeamId === e.teamId;
              const rankColour = isAdvanced ? "text-green-400" : isEliminated ? "text-red-400" : "text-gray-400";
              const nameColour = isAdvanced ? "text-green-300" : isEliminated ? "text-red-300" : "text-white";
              return (
                <Fragment key={e.teamId || `placeholder-${i}`}>
                  <tr
                    className={`border-b border-white/5 ${rowTint} ${expandable ? "cursor-pointer hover:bg-white/5" : ""}`}
                    onClick={expandable ? () => setExpandedTeamId(isExpanded ? null : e.teamId) : undefined}
                  >
                    <td className={`px-2 py-1.5 font-medium tabular-nums ${rankColour}`}>{e.rank ?? i + 1}</td>
                    <td className={`px-2 py-1.5 ${nameColour}`}>
                      <span className="inline-flex items-center gap-1.5">
                        <span className="truncate">{e.name}</span>
                        {isAdvanced && <span className="text-green-400 text-[10px] shrink-0">✓</span>}
                        {isEliminated && <span className="text-red-400 text-[10px] shrink-0">✗</span>}
                      </span>
                    </td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${nameColour}`}>{e.score || "–"}</td>
                    <td className="px-1 py-1.5 text-center text-gray-500 text-[10px]">
                      {expandable ? (isExpanded ? "▼" : "▶") : ""}
                    </td>
                  </tr>
                  {isExpanded && e.playerScores && (
                    <tr className={rowTint}>
                      <td colSpan={4} className="px-2 pb-2">
                        <div className="flex flex-col gap-1 bg-slate-900/40 rounded p-2">
                          {e.playerScores.some(p => p.isTempCaptain) && (
                            <div className="text-[10px] text-amber-400/70 mb-1">
                              C* = auto-assigned temp captain (lowest scorer)
                            </div>
                          )}
                          {e.playerScores.map((p, idx) => (
                            <div key={idx} className="flex items-center justify-between text-xs">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <a
                                  href={`https://fantasy.premierleague.com/entry/${p.fplId}/event/33`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-400 hover:text-blue-300 underline truncate"
                                >
                                  {p.name}
                                </a>
                                {p.isCaptain && p.isTempCaptain && (
                                  <span
                                    className="px-1 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-400 shrink-0"
                                    title="Auto-assigned: lowest current scorer."
                                  >
                                    C*
                                  </span>
                                )}
                                {p.isCaptain && !p.isTempCaptain && (
                                  <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-yellow-500/20 text-yellow-400 shrink-0">C</span>
                                )}
                              </div>
                              <PlayerScoreFormula
                                fplScore={p.fplScore}
                                transferHits={p.transferHits}
                                finalScore={p.finalScore}
                                isCaptain={p.isCaptain}
                                isTempCaptain={p.isTempCaptain}
                              />
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
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
  // Default-expanded GWs are derived from props (the current GW per round). User toggles layer on
  // top as overrides — derived-at-render keeps this off the setState-in-effect path.
  const [overrides, setOverrides] = useState<Record<string, Set<number>>>({});
  const defaultExpanded = useMemo<Record<string, Set<number>>>(() => {
    const currentGw = latestCompletedGw ? (latestCompletedGw < 33 ? latestCompletedGw + 1 : 33) : 31;
    const result: Record<string, Set<number>> = {};
    groups.forEach((g) => { result[g.roundPrefix] = new Set([currentGw]); });
    return result;
  }, [groups, latestCompletedGw]);
  const expandedGws: Record<string, Set<number>> = { ...defaultExpanded, ...overrides };

  const toggleGwExpanded = (groupPrefix: string, gw: number) => {
    setOverrides((prev) => {
      const next = { ...prev };
      const current = next[groupPrefix] ?? defaultExpanded[groupPrefix] ?? new Set<number>();
      const updated = new Set(current);
      if (updated.has(gw)) updated.delete(gw);
      else updated.add(gw);
      next[groupPrefix] = updated;
      return next;
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
                                <MatchCard key={tie.tieId} tie={tie} compact liveScores={mergedScores} />
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
                                <MatchCard key={tie.tieId} tie={tie} compact liveScores={mergedScores} />
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
