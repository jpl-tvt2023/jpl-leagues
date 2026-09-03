"use client";

import { HelpTip } from "@/components/HelpTip";
import { PlayerBreakdown, type Fixture } from "./shared";
import {
  challengeOutcomeLabel,
  type ChallengeMatch,
} from "@/lib/formats/tvt/challenge-match";

/**
 * A chip pill that, for a Challenge Chip, reveals the challenge match on hover OR tap.
 *
 * Two things this deliberately does NOT do:
 *
 *  1. It does not use `ChipPill`, whose tooltip is a native `title=` — invisible on touch,
 *     which is the exact problem this component exists to solve.
 *  2. It does not pass `liveData` to PlayerBreakdown. PlayerBreakdown prefers live data over
 *     the stored JSON when given it, which would make a GW2 challenge silently re-render with
 *     GW3 numbers once GW3 kicks off. The challenge is pinned to the gameweek it was played in.
 *
 *     `liveChallenge` does NOT breach that rule. It is a whole match already assembled from the
 *     live snapshot of its OWN gameweek by challenge-match-live.ts, which the caller only builds
 *     when the chip's gameweek is the one in flight. PlayerBreakdown still receives no `liveData`
 *     and still cannot reach across gameweeks. Do not "simplify" this into passing liveData.
 *
 * A challenge is not a league fixture — it decides only whether the challenger banks +2 chip
 * points, and never counts toward matches played or won. The wording below reflects that and
 * avoids the Final / W-D-L vocabulary the fixture cards use.
 */
export interface ChipDisplay {
  chipType: string;
  chipCode: string;
  chipName: string;
  challengedTeamName?: string | null;
  challengedTeamId?: string | null;
  challenge?: ChallengeMatch | null;
  /** The chip was spent but awarded nothing — see fixtures/route.ts for the two ways this happens. */
  isWasted?: boolean;
  /** Why, once `isWasted` is true. Null for a chip wasted before this field existed. */
  wastedReason?: string | null;
}

export function ChallengeTip({
  chip,
  liveChallenge,
  /**
   * A not-yet-certain "this will be wasted" read, computed client-side from FPL chip history
   * before the gameweek is scored. Ignored once `chip.isWasted` is set — stored, scored fact
   * always wins over a prediction — and ignored once the chip is confirmed NOT wasted.
   */
  predictedWasteReason,
  align = "left",
  className = "",
}: {
  chip: ChipDisplay;
  /**
   * The in-progress challenge, built by the caller from the live scores of the chip's own
   * gameweek. Only consulted when there is no settled match: a scored challenge is final and
   * must never be redrawn from a live snapshot.
   */
  liveChallenge?: ChallengeMatch | null;
  predictedWasteReason?: string | null;
  /** Which edge the pill hugs — mirrors the fixture card's home/away columns. */
  align?: "left" | "right";
  className?: string;
}) {
  const isChallenge = chip.chipType === "C";
  const match = isChallenge ? chip.challenge ?? liveChallenge ?? null : null;

  const isWasted = chip.isWasted === true;
  // A prediction only means anything before the fact is known, and never overrides it.
  const isPredictedWaste = !isWasted && !!predictedWasteReason;

  // Plain text whenever there is no rebuilt match: an unscored gameweek, or a side on a bye.
  // No "pending" wording — the chip simply names its target until there is a result to show.
  const plainTip = isWasted && chip.wastedReason
    ? chip.wastedReason
    : isPredictedWaste
    ? `${chip.chipName} — may be wasted: ${predictedWasteReason}. Confirmed once the gameweek is scored.`
    : isChallenge && chip.challengedTeamName
    ? `${chip.chipName} — challenging ${chip.challengedTeamName}`
    : chip.chipName;

  const tip = match ? (
    <ChallengeSummary
      match={match}
      wastedReason={isWasted ? chip.wastedReason : null}
      predictedWasteReason={isPredictedWaste ? predictedWasteReason : null}
    />
  ) : (
    plainTip
  );

  const pill = (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span
        className={`block truncate rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap ${
          isWasted
            ? "bg-white/5 text-gray-500 line-through decoration-red-400/70"
            : "bg-yellow-400/20 text-yellow-300"
        }`}
        aria-label={typeof tip === "string" ? tip : `${chip.chipName} — view challenge result`}
      >
        {chip.chipCode}
      </span>
      {isWasted && (
        <span className="shrink-0 rounded bg-red-500/20 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-red-400">
          Wasted
        </span>
      )}
      {isPredictedWaste && (
        <span className="shrink-0 rounded border border-amber-400/40 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-amber-400">
          May waste
        </span>
      )}
    </span>
  );

  return (
    // No default margin: the dashboard's chip column and the fixture card want different
    // spacing, and a hardcoded one here would collide with whatever the caller passes.
    <span className={`flex ${align === "right" ? "justify-end" : "justify-start"} ${className}`}>
      <HelpTip tip={tip} wide={!!match} className="no-underline flex min-w-0">
        {pill}
      </HelpTip>
    </span>
  );
}

/** The rich tooltip body: a header stating the chip outcome, then the standard breakdown. */
function ChallengeSummary({
  match,
  wastedReason,
  predictedWasteReason,
}: {
  match: ChallengeMatch;
  /** Set → the Challenge Chip itself was wasted by an FPL chip clash. Overrides the outcome line: a wasted chip lost or won nothing, whatever the scoreline says. */
  wastedReason?: string | null;
  /** Set → not yet certain, shown as an added warning alongside whatever else is on screen. */
  predictedWasteReason?: string | null;
}) {
  // Synthetic fixture — never persisted. Turning this into a real fixtures row would make the
  // league table count the challenge as a match and double-count its points.
  const challengeFixture: Fixture = {
    id: `challenge-gw${match.gameweek}-${match.challengerTeamName}`,
    homeTeam: { name: match.challengerTeamName },
    awayTeam: { name: match.challengedTeamName },
    gameweek: { number: match.gameweek },
    result: {
      homeScore: match.challengerScore,
      awayScore: match.challengedScore,
      homePlayerScores: match.challengerPlayerScores,
      awayPlayerScores: match.challengedPlayerScores,
    },
  };

  const isLive = match.outcome === "live";
  const isWasted = !!wastedReason;

  return (
    <div className="w-[min(88vw,392px)]">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-400">
        <span>Challenge Chip · GW{match.gameweek}</span>
        {isLive && !isWasted && (
          <span className="animate-pulse font-bold text-green-400">LIVE</span>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-white">
        <span className="truncate">{match.challengerTeamName}</span>
        <span className={`shrink-0 font-bold ${isLive && !isWasted ? "text-green-400" : ""}`}>
          {match.challengerScore} – {match.challengedScore}
        </span>
        <span className="truncate text-right">{match.challengedTeamName}</span>
      </div>
      <div
        className={`mt-1 text-[11px] font-semibold ${
          isWasted ? "text-red-400" : isLive ? "text-green-400" : "text-yellow-300"
        }`}
      >
        {/* A wasted chip never reads as won/lost/drew — the scoreline above is unrelated to why
            it produced nothing, and saying "lost" would blame the wrong thing. */}
        {isWasted ? wastedReason : challengeOutcomeLabel(match)}
      </div>
      {!isWasted && predictedWasteReason && (
        <div className="mt-1 text-[11px] font-semibold text-amber-400">
          May be wasted — {predictedWasteReason}. Confirmed once the gameweek is scored.
        </div>
      )}
      {/* No chips props: renders the standard breakdown WITHOUT the TVT chip rows. FPL chip
          pills are not shown here either — the challenger and challenged team are DIFFERENT
          teams from two different groups, so a single BreakdownChips could not correctly label
          both sides without risking one team's chips being shown under the other's name. */}
      <PlayerBreakdown fixture={challengeFixture} />
      <div className="mt-1.5 text-[9px] leading-snug text-gray-500">
        {isWasted
          ? "Chip points only — the challenge does not count toward matches played or won."
          : isLive
          ? "Chip points are decided when the gameweek is scored — nothing is banked yet."
          : "Chip points only — the challenge does not count toward matches played or won."}
      </div>
    </div>
  );
}
