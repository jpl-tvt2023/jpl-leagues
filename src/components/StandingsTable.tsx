"use client";

import type { TeamStanding } from "@/types/standings";
import { HelpTip } from "@/components/HelpTip";

/** Both breakdowns are a short list of label/value rows; 320px reads them without wrapping. */
const BREAKDOWN_WIDTH = 320;

export function StandingsTable({ teams, group, isContinentalChampionship }: { teams: TeamStanding[]; group?: string; isContinentalChampionship?: boolean }) {
  return (
    <>
      <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur overflow-hidden">
        {group && (
          <div className="bg-gradient-to-r from-purple-700/40 to-purple-900/40 px-3 py-2 sm:px-4 sm:py-3 border-b border-purple-500/20">
            <h2 className="text-base sm:text-lg font-bold text-white">Group {group}</h2>
          </div>
        )}
        {/* Phones fold MP/W/D/L into a sub-line under the team name (see ExpandableRow.tsx for
            the pattern), leaving Rank · Team · CP/BP · Pts · Scores — which fits 360px. */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-purple-500/20 bg-purple-900/30 text-[10px] sm:text-xs text-gray-300">
                <th className="px-2 py-2 sm:px-3 text-left font-medium w-10">Rank</th>
                <th className="px-2 py-2 text-left font-medium">Team</th>
                <th className="hidden sm:table-cell px-1.5 py-2 sm:px-2 text-center font-medium w-9">MP</th>
                <th className="hidden sm:table-cell px-1.5 py-2 sm:px-2 text-center font-medium w-8">W</th>
                <th className="hidden sm:table-cell px-1.5 py-2 sm:px-2 text-center font-medium w-8">D</th>
                <th className="hidden sm:table-cell px-1.5 py-2 sm:px-2 text-center font-medium w-8">L</th>
                {!isContinentalChampionship && <th className="px-1.5 py-2 sm:px-2 text-center font-medium w-12" title="Chips and Bonus Points">CP/BP</th>}
                <th className="px-1.5 py-2 sm:px-2 text-center font-medium w-14">Pts</th>
                <th className="px-1.5 py-2 sm:px-2 text-center font-medium w-16">Scores</th>
              </tr>
            </thead>
            <tbody>
              {teams.length === 0 ? (
                <tr>
                  <td colSpan={isContinentalChampionship ? 8 : 9} className="px-3 py-8 text-center text-gray-500">
                    No teams in this group yet
                  </td>
                </tr>
              ) : (
                teams.map((team) => (
                  <tr
                    key={team.teamId}
                    className={`border-b border-white/5 transition hover:bg-white/5 ${
                      isContinentalChampionship
                        ? team.groupRank <= 4 ? "bg-green-500/5" : "bg-white/2"
                        : team.zone === "playoffs"
                          ? "bg-green-500/5"
                          : team.zone === "challenger"
                          ? "bg-yellow-500/5"
                          : "bg-red-500/5"
                    }`}
                  >
                    <td className="px-2 py-2 sm:px-3">
                      <div className="inline-flex items-center gap-1.5">
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] sm:text-xs font-bold ${
                            isContinentalChampionship
                              ? team.groupRank <= 4 ? "bg-green-500/20 text-green-400" : "bg-white/10 text-gray-400"
                              : team.zone === "playoffs"
                                ? "bg-green-500/20 text-green-400"
                                : team.zone === "challenger"
                                ? "bg-yellow-500/20 text-yellow-400"
                                : "bg-red-500/20 text-red-400"
                          }`}
                        >
                          {team.groupRank}
                        </span>
                        {team.rankDelta != null && team.rankDelta !== 0 ? (
                          <span
                            className={`font-mono text-[10px] sm:text-xs ${team.rankDelta > 0 ? "text-green-400" : "text-red-400"}`}
                            title={team.previousRank != null ? `Was #${team.previousRank} last GW` : undefined}
                          >
                            {team.rankDelta > 0 ? `▲${team.rankDelta}` : `▼${Math.abs(team.rankDelta)}`}
                          </span>
                        ) : team.rankDelta === 0 ? (
                          <span className="font-mono text-[10px] sm:text-xs text-gray-500" title="No change vs previous GW">—</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-2 font-medium text-white leading-tight min-w-0 max-w-[140px] sm:max-w-none">
                      <div className="truncate">{team.name}</div>
                      <div className="sm:hidden mt-0.5 text-[10px] font-normal text-gray-400 whitespace-nowrap">
                        {team.played}P ·{" "}
                        <span className="text-green-400">{team.wins}W</span>{" "}
                        <span>{team.draws}D</span>{" "}
                        <span className="text-red-400">{team.losses}L</span>
                      </div>
                    </td>
                    <td className="hidden sm:table-cell px-1.5 py-2 sm:px-2 text-center text-gray-400">{team.played}</td>
                    <td className="hidden sm:table-cell px-1.5 py-2 sm:px-2 text-center text-green-400">{team.wins}</td>
                    <td className="hidden sm:table-cell px-1.5 py-2 sm:px-2 text-center text-gray-400">{team.draws}</td>
                    <td className="hidden sm:table-cell px-1.5 py-2 sm:px-2 text-center text-red-400">{team.losses}</td>
                    {!isContinentalChampionship && (
                      <td className="px-1.5 py-2 sm:px-2 text-center text-purple-400">
                        {/* Padded so the tap target is bigger than a one-digit number; the negative margins cancel
                            the padding so the table is no wider on a 360px phone. */}
                        <HelpTip tip={<CbpTooltipBody team={team} />} width={BREAKDOWN_WIDTH} className="inline-block -mx-1 -my-0.5 px-1 py-0.5">
                          {team.cbpPoints}
                        </HelpTip>
                      </td>
                    )}
                    <td className="px-1.5 py-2 sm:px-2 text-center font-bold text-white">{team.leaguePoints}</td>
                    <td className="px-1.5 py-2 sm:px-2 text-center text-gray-400">
                      <HelpTip tip={<ScoresTooltipBody team={team} />} width={BREAKDOWN_WIDTH} className="inline-block -mx-1 -my-0.5 px-1 py-0.5">
                        {team.pointsFor}
                      </HelpTip>
                    </td>
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

/**
 * The CP/BP column's breakdown. Lifted out of StandingsTable unchanged when the Scores column
 * gained a breakdown of its own: one bubble, two bodies, rather than a fragment nested inside
 * the positioning wrapper.
 */
function CbpTooltipBody({ team }: { team: TeamStanding }) {
  return (
    <>
        <p className="text-gray-400 text-xs font-semibold mb-2 uppercase tracking-wide">CP/BP Breakdown</p>
        {/* Chips */}
        <div className="space-y-1 mb-2">
          {team.cbpTooltip.chips.map((chip, i) => {
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
        {/* BPS entries */}
        {team.cbpTooltip.bps.length > 0 && (
          <div className="pt-2 border-t border-white/10 mb-2">
            <p className="text-gray-500 text-xs mb-1 uppercase tracking-wide">BPS</p>
            <div className="space-y-1">
              {team.cbpTooltip.bps.map((b, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-gray-400">GW{b.gameweek}</span>
                  <span className="text-blue-400 font-bold">+{b.points}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Hit Penalty entries */}
        {team.cbpTooltip.hitPenalty.penaltyGws.length > 0 && (
          <div className="pt-2 border-t border-white/10 mb-2">
            <p className="text-gray-500 text-xs mb-1 uppercase tracking-wide">Hit Penalty</p>
            <div className="space-y-1">
              {team.cbpTooltip.hitPenalty.penaltyGws.map((p, i) => (
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
          <span className="text-purple-300 font-bold">+{team.cbpPoints}</span>
        </div>
        {team.cbpTooltip.hitPenalty.totalDeduction > 0 && (
          <div className="flex justify-between text-xs mt-1">
            <span className="text-gray-400">Hit Deduction</span>
            <span className="text-red-400 font-bold">
              -{team.cbpTooltip.hitPenalty.totalDeduction} pt{team.cbpTooltip.hitPenalty.totalDeduction > 1 ? "s" : ""}
            </span>
          </div>
        )}
    </>
  );
}

/**
 * The Scores column's breakdown.
 *
 * Exists because the standings table shows one score but the tiebreaker compares two, and they
 * are not the same number. `pointsFor` is the match score with the captain doubled; `fplNetScore`
 * is the flat sum of each player's points net of hits. A reader comparing two level teams cannot
 * otherwise tell which of the two settled it.
 */
function ScoresTooltipBody({ team }: { team: TeamStanding }) {
  return (
    <>
      <p className="text-gray-400 text-xs font-semibold mb-2 uppercase tracking-wide">Score Breakdown</p>
      <div className="space-y-2">
        <div>
          <div className="flex justify-between gap-2 text-xs">
            <span className="text-gray-400">Total Overall Score</span>
            <span className="text-white font-bold">{team.pointsFor}</span>
          </div>
          <p className="text-gray-500 text-[10px] mt-0.5">With captain doubled &middot; tiebreaker 2</p>
        </div>
        <div className="pt-2 border-t border-white/10">
          <div className="flex justify-between gap-2 text-xs">
            <span className="text-gray-400">Total FPL Score</span>
            <span className="text-white font-bold">{team.fplNetScore}</span>
          </div>
          <p className="text-gray-500 text-[10px] mt-0.5">Net of hits, no captain doubling &middot; tiebreaker 6</p>
        </div>
      </div>
    </>
  );
}
