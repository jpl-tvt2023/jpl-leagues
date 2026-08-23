"use client";

import { PlayerScoreFormula } from "../playoffs/shared";
import { FplEntryLink } from "@/components/FplEntryLink";
import { ChipPill, FplChipRow } from "@/components/ChipPill";
import {
  chipState,
  type ChipState,
  type FplChipStatus,
} from "@/lib/fpl-league/chips";

/**
 * Chip state for one side of a fixture, folded into the points breakdown.
 *
 * Optional throughout: the fixtures page renders the breakdown without chips,
 * and only the dashboard card passes them. Keeping it opt-in means adding this
 * did not change the fixtures page at all.
 */
export interface BreakdownChips {
  /** FPL chip status per manager, keyed by fplId. */
  byFplId: Record<string, FplChipStatus | null>;
  /**
   * The team's TVT chips with their state already resolved by the caller.
   *
   * State rather than a raw gameweek, because a TVT chip can be known-spent
   * with no *publishable* gameweek: declarations for a gameweek whose deadline
   * has not passed are withheld so an opponent cannot read them early. Such a
   * chip is "past" with a null gameweek, which no (usedGw, currentGw) pair can
   * express.
   */
  tvt: { code: string; label: string; state: ChipState; gw: number | null }[];
  /** Which chip set these belong to, e.g. "Set 1". */
  tvtLabel: string;
}

export interface LivePlayerScore {
  name: string;
  fplId: string;
  fplScore: number;
  transferHits: number;
  isCaptain: boolean;
  isAutoAssigned?: boolean;
  isTempCaptain?: boolean;
  finalScore: number;
}

export interface LiveFixtureScore {
  fixtureId: string;
  gameweek: number;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  homePlayers: LivePlayerScore[];
  awayPlayers: LivePlayerScore[];
  /** Fixtures still to play across the side's active XI. null = FPL unreachable. */
  homePlayersLeft?: { leftToPlay: number; total: number } | null;
  awayPlayersLeft?: { leftToPlay: number; total: number } | null;
}

export interface FixtureTeam {
  id?: string;
  name: string;
  isGhost?: boolean;
}

export interface FixtureResult {
  homeScore: number;
  awayScore: number;
  homeMatchPoints?: number;
  awayMatchPoints?: number;
  homePlayerScores?: string | null;
  awayPlayerScores?: string | null;
}

export interface Fixture {
  id: string;
  homeTeam: FixtureTeam;
  awayTeam: FixtureTeam;
  group?: { name: string } | null;
  competitionType?: string | null;
  gameweek: { number: number; deadline?: Date };
  result?: FixtureResult | null;
}

export type GameweekFixtures = Record<number, Fixture[]>;

export function PlayerBreakdownSide({
  players,
  teamLabel,
  gwNumber,
  isGhost,
  ghostScore,
  playersLeft,
  chips,
  linkGw,
}: {
  players: LivePlayerScore[];
  teamLabel: string;
  gwNumber: number;
  isGhost?: boolean;
  ghostScore?: number;
  playersLeft?: { leftToPlay: number; total: number } | null;
  /** Omit to render the breakdown without any chip rows, as the fixtures page does. */
  chips?: BreakdownChips;
  /**
   * Gameweek the manager links should point at, when that differs from the one
   * being displayed. FPL only resolves /entry/{id}/event/{n} once gameweek n has
   * kicked off, so a card showing a future gameweek must still link to the last
   * one that started. Defaults to `gwNumber`.
   */
  linkGw?: number | null;
}) {
  const hrefGw = linkGw !== undefined ? linkGw : gwNumber;
  return (
    <div>
      <div className="text-[10px] text-gray-400 mb-1 text-center">{teamLabel}</div>
      {playersLeft !== undefined && !isGhost && (
        <div
          className={`text-[10px] mb-1 text-center ${
            playersLeft === null
              ? "text-gray-600"
              : playersLeft.leftToPlay > 0
              ? "text-emerald-400"
              : "text-gray-500"
          }`}
          title={
            playersLeft === null
              ? "Could not reach FPL for fixture data"
              : "Fixtures still to play across both managers' active picks"
          }
        >
          {playersLeft === null
            ? "—"
            : `⏳ ${playersLeft.leftToPlay}/${playersLeft.total} left`}
        </div>
      )}
      {isGhost ? (
        <div className="text-center py-3">
          <span className="text-purple-400 italic text-xs">Ghost (Group Avg)</span>
          {ghostScore !== undefined && (
            <div className="text-purple-300 font-bold mt-1">{ghostScore}</div>
          )}
        </div>
      ) : players.length > 0 ? (
        players.map((p, i) => (
          <div key={i} className="py-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 min-w-0">
                <FplEntryLink
                  fplId={p.fplId}
                  gw={hrefGw}
                  className="text-blue-400 hover:text-blue-300 underline truncate"
                  stopPropagation
                >
                  {p.name}
                </FplEntryLink>
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
              <div className="text-right shrink-0 ml-2">
                <PlayerScoreFormula
                  fplScore={p.fplScore}
                  transferHits={p.transferHits}
                  finalScore={p.finalScore}
                  isCaptain={p.isCaptain}
                  isTempCaptain={p.isTempCaptain}
                />
              </div>
            </div>
            {/* This manager's FPL chips, directly under their name — the point
                of folding them in here rather than repeating the manager list
                in a separate block above. */}
            {chips && (
              <div className="flex flex-wrap gap-0.5 mt-0.5">
                <FplChipRow status={chips.byFplId[p.fplId]} gwNumber={gwNumber} />
              </div>
            )}
          </div>
        ))
      ) : (
        <div className="text-center text-gray-500 italic text-[10px] py-2">No breakdown available</div>
      )}

      {/* The side's TVT chips, once per team rather than once per manager —
          they belong to the team, not to either individual manager. */}
      {chips && chips.tvt.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-white/10">
          <div className="text-[9px] text-gray-500 mb-0.5">TVT chips ({chips.tvtLabel})</div>
          <div className="flex flex-wrap gap-0.5">
            {chips.tvt.map((c) => (
              <ChipPill key={c.code} code={c.code} label={c.label} state={c.state} gw={c.gw} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function PlayerBreakdown({
  fixture,
  liveData,
  homeChips,
  awayChips,
  linkGw,
}: {
  fixture: Fixture;
  liveData?: LiveFixtureScore;
  /** Optional — only the dashboard card folds chips into the breakdown. */
  homeChips?: BreakdownChips;
  awayChips?: BreakdownChips;
  /** See PlayerBreakdownSide: overrides the gameweek manager links point at. */
  linkGw?: number | null;
}) {
  const homePlayers: LivePlayerScore[] =
    (liveData?.homePlayers?.length ?? 0) > 0
      ? liveData!.homePlayers
      : fixture.result?.homePlayerScores
      ? (JSON.parse(fixture.result.homePlayerScores) as LivePlayerScore[])
      : [];
  const awayPlayers: LivePlayerScore[] =
    (liveData?.awayPlayers?.length ?? 0) > 0
      ? liveData!.awayPlayers
      : fixture.result?.awayPlayerScores
      ? (JSON.parse(fixture.result.awayPlayerScores) as LivePlayerScore[])
      : [];
  const gwNumber = liveData?.gameweek ?? fixture.gameweek.number;

  if (homePlayers.length === 0 && awayPlayers.length === 0 && !fixture.homeTeam.isGhost && !fixture.awayTeam.isGhost) {
    return (
      <div className="mt-1 pt-2 border-t border-white/10 text-center text-gray-500 italic text-[10px] py-2">
        Player breakdown not available for this gameweek
      </div>
    );
  }

  const hasTempCaptain = [...homePlayers, ...awayPlayers].some(p => p.isTempCaptain);

  return (
    <div className="mt-1 pt-2 border-t border-white/10 text-xs">
      <div className="grid grid-cols-2 gap-2 sm:gap-4">
        <PlayerBreakdownSide
          players={homePlayers}
          teamLabel={fixture.homeTeam.name}
          gwNumber={gwNumber}
          isGhost={fixture.homeTeam.isGhost}
          ghostScore={fixture.result?.homeScore}
          playersLeft={liveData?.homePlayersLeft}
          chips={homeChips}
          linkGw={linkGw}
        />
        <PlayerBreakdownSide
          players={awayPlayers}
          teamLabel={fixture.awayTeam.name}
          gwNumber={gwNumber}
          isGhost={fixture.awayTeam.isGhost}
          ghostScore={fixture.result?.awayScore}
          playersLeft={liveData?.awayPlayersLeft}
          chips={awayChips}
          linkGw={linkGw}
        />
      </div>
      {hasTempCaptain && (
        <div className="mt-2 text-[10px] text-amber-400/70">
          C* = auto-assigned temp captain (lowest scorer)
        </div>
      )}
    </div>
  );
}
