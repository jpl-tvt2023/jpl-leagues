"use client";

import { PlayerScoreFormula } from "../playoffs/shared";
import { FplEntryLink } from "@/components/FplEntryLink";
import { fplEntryLabel } from "@/lib/fpl-links";
import { ChipPill, FplChipRow, FplChipsPlayedInGw } from "@/components/ChipPill";
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
  /**
   * Open chip tooltips on tap as well as hover, and say so.
   *
   * The public fixtures page sets this: it is read on phones, where a native `title=` tooltip
   * simply does not exist, and the chip is frequently the whole explanation for a score. The
   * dashboard leaves it off and keeps the tooltip it already had.
   */
  interactive?: boolean;
  /**
   * Render nothing for a manager whose FPL chip history is unknown, rather than a placeholder.
   * The fixtures page reads chips from cache only, so "unknown" is the normal cold state.
   */
  silentWhenUnknown?: boolean;
  /**
   * Show ONLY the chip(s) this manager played in the gameweek on screen, inline beside their name —
   * instead of the full six-chip inventory row.
   *
   * The fixtures page sets this; the dashboard card and the FPL League table deliberately do not.
   * Those two exist to answer "what does this manager still hold?", so the inventory is the point.
   * A fixture card answers a different question — "why does this score look like that?" — and for
   * that, five green "available" pills plus an unrelated `WC1 3` from a gameweek nobody is looking
   * at is noise that reads as a highlight. It also made the display look arbitrary: chip data is
   * cache-only here, so some managers showed six pills and their opponent showed none.
   *
   * Showing only what was played makes "nothing" the normal case, so a manager with a cold cache
   * and one who genuinely played nothing render identically — which is the honest outcome, since
   * we cannot tell them apart.
   */
  playedOnly?: boolean;
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
  roster,
  teamLabel,
  gwNumber,
  isGhost,
  ghostScore,
  playersLeft,
  chips,
  linkGw,
}: {
  players: LivePlayerScore[];
  /**
   * The side's managers, for when there are no scores to show yet — the
   * gameweek has not kicked off. Rendered as names and chips only. Omit it and
   * a scoreless side reads "No breakdown available", as the fixtures page wants.
   */
  roster?: { name: string; fplId: string }[];
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
                {/* Chips played THIS gameweek, inline beside the name. Usually nothing. */}
                {chips?.playedOnly && (
                  <FplChipsPlayedInGw
                    status={chips.byFplId[p.fplId]}
                    gwNumber={gwNumber}
                    interactive={chips.interactive}
                  />
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
            {/* This manager's full FPL chip inventory, directly under their name — the point
                of folding them in here rather than repeating the manager list
                in a separate block above. Suppressed when the caller asked for played-only
                chips, which are rendered inline beside the name instead. */}
            {chips && !chips.playedOnly && (
              <div className="flex flex-wrap gap-0.5 mt-0.5">
                <FplChipRow
                  status={chips.byFplId[p.fplId]}
                  gwNumber={gwNumber}
                  interactive={chips.interactive}
                  silentWhenUnknown={chips.silentWhenUnknown}
                />
              </div>
            )}
          </div>
        ))
      ) : roster && roster.length > 0 ? (
        /* No scores yet — the gameweek has not kicked off. Show who is playing,
           where to read their last gameweek, and what chips they hold. */
        roster.map((p, i) => (
          <div key={i} className="py-1">
            <div className="flex items-center justify-between gap-1">
              <FplEntryLink
                fplId={p.fplId}
                gw={hrefGw}
                className="text-blue-400 hover:text-blue-300 underline truncate"
                stopPropagation
              >
                {p.name}
              </FplEntryLink>
              {/* The link points at the last gameweek that started, not the one
                  on screen — FPL cannot render a gameweek that has not kicked
                  off. Say which, so the destination is not a surprise. */}
              <span className="text-[9px] text-gray-500 shrink-0">{fplEntryLabel(hrefGw)} ↗</span>
            </div>
            {chips && !chips.playedOnly && (
              <div className="flex flex-wrap gap-0.5 mt-0.5">
                <FplChipRow
                  status={chips.byFplId[p.fplId]}
                  gwNumber={gwNumber}
                  interactive={chips.interactive}
                  silentWhenUnknown={chips.silentWhenUnknown}
                />
              </div>
            )}
            {/* Roster view: the gameweek has not kicked off, so nothing can have been played in it
                yet. Rendered anyway so a late-published chip appears the moment it is known. */}
            {chips?.playedOnly && (
              <div className="flex flex-wrap gap-0.5 mt-0.5">
                <FplChipsPlayedInGw
                  status={chips.byFplId[p.fplId]}
                  gwNumber={gwNumber}
                  interactive={chips.interactive}
                />
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
              <ChipPill
                key={c.code}
                code={c.code}
                label={c.label}
                state={c.state}
                gw={c.gw}
                interactive={chips.interactive}
              />
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
  homeRoster,
  awayRoster,
  linkGw,
  hidePlayersLeft,
}: {
  fixture: Fixture;
  liveData?: LiveFixtureScore;
  /**
   * Each side's managers, used only when that side has no scores yet. Lets a
   * caller render a fixture whose gameweek has not kicked off as a line-up
   * rather than as nothing at all. See PlayerBreakdownSide.
   */
  homeRoster?: { name: string; fplId: string }[];
  awayRoster?: { name: string; fplId: string }[];
  /** Optional — only the dashboard card folds chips into the breakdown. */
  homeChips?: BreakdownChips;
  awayChips?: BreakdownChips;
  /** See PlayerBreakdownSide: overrides the gameweek manager links point at. */
  linkGw?: number | null;
  /**
   * Suppress the per-side players-left line. For callers that already show the
   * number somewhere always-visible — the dashboard card shows it in its header,
   * which stays on screen when the breakdown is collapsed — repeating it here
   * would print the same figure twice on expand.
   */
  hidePlayersLeft?: boolean;
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

  const hasRoster = (homeRoster?.length ?? 0) > 0 || (awayRoster?.length ?? 0) > 0;

  if (
    homePlayers.length === 0 &&
    awayPlayers.length === 0 &&
    !hasRoster &&
    !fixture.homeTeam.isGhost &&
    !fixture.awayTeam.isGhost
  ) {
    return (
      <div className="mt-1 pt-2 border-t border-white/10 text-center text-gray-500 italic text-[10px] py-2">
        Player breakdown not available for this gameweek
      </div>
    );
  }

  const hasTempCaptain = [...homePlayers, ...awayPlayers].some(p => p.isTempCaptain);

  // Is any chip pill actually rendered below? In playedOnly mode that is the exception rather than
  // the rule, and the "tap a chip" hint must not point at an empty breakdown. Mirrors exactly what
  // FplChipsPlayedInGw / FplChipRow decide to draw, per side.
  const anyChipOnScreen = [
    [homeChips, homeRoster, homePlayers] as const,
    [awayChips, awayRoster, awayPlayers] as const,
  ].some(([chipSet, sideRoster, sidePlayers]) => {
    if (!chipSet) return false;
    const fplIds = (sidePlayers.length > 0 ? sidePlayers : sideRoster ?? []).map((p) => p.fplId);
    if (!chipSet.playedOnly) return fplIds.some((id) => chipSet.byFplId[id]);
    return fplIds.some((id) => chipSet.byFplId[id]?.used.some((u) => u.gw === gwNumber));
  });

  return (
    <div className="mt-1 pt-2 border-t border-white/10 text-xs">
      <div className="grid grid-cols-2 gap-2 sm:gap-4">
        <PlayerBreakdownSide
          players={homePlayers}
          roster={homeRoster}
          teamLabel={fixture.homeTeam.name}
          gwNumber={gwNumber}
          isGhost={fixture.homeTeam.isGhost}
          ghostScore={fixture.result?.homeScore}
          playersLeft={hidePlayersLeft ? undefined : liveData?.homePlayersLeft}
          chips={homeChips}
          linkGw={linkGw}
        />
        <PlayerBreakdownSide
          players={awayPlayers}
          roster={awayRoster}
          teamLabel={fixture.awayTeam.name}
          gwNumber={gwNumber}
          isGhost={fixture.awayTeam.isGhost}
          ghostScore={fixture.result?.awayScore}
          playersLeft={hidePlayersLeft ? undefined : liveData?.awayPlayersLeft}
          chips={awayChips}
          linkGw={linkGw}
        />
      </div>
      {hasTempCaptain && (
        <div className="mt-2 text-[10px] text-amber-400/70">
          C* = auto-assigned temp captain (lowest scorer)
        </div>
      )}
      {/* Said once for the whole breakdown, not per side — the chips are all the same kind of
          thing and repeating the instruction twice reads as two different instructions.
          In playedOnly mode most gameweeks show no chips at all, so the hint is gated on at least
          one actually being rendered; otherwise it points at nothing. */}
      {(homeChips?.interactive || awayChips?.interactive) && anyChipOnScreen && (
        <div className="mt-2 text-[10px] text-gray-500 text-center">
          Tap or hover a chip to see what it is and when it was played.
        </div>
      )}
      {/* Nothing scored on either side: say why, rather than leaving a
          line-up that looks like it is missing its numbers. */}
      {homePlayers.length === 0 && awayPlayers.length === 0 && hasRoster && (
        <div className="mt-2 text-[10px] text-gray-500 text-center">
          Scores appear once GW{gwNumber} kicks off.
        </div>
      )}
    </div>
  );
}
