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
 * A challenge is not a league fixture — it decides only whether the challenger banks +2 chip
 * points, and never counts toward matches played or won. The wording below reflects that and
 * avoids the Final / W-D-L vocabulary the fixture cards use.
 */
export interface ChipDisplay {
  chipType: string;
  chipCode: string;
  chipName: string;
  challengedTeamName?: string | null;
  challenge?: ChallengeMatch | null;
}

export function ChallengeTip({
  chip,
  align = "left",
  className = "",
}: {
  chip: ChipDisplay;
  /** Which edge the pill hugs — mirrors the fixture card's home/away columns. */
  align?: "left" | "right";
  className?: string;
}) {
  const isChallenge = chip.chipType === "C";
  const match = isChallenge ? chip.challenge ?? null : null;

  // Plain text whenever there is no rebuilt match: an unscored gameweek, or a side on a bye.
  // No "pending" wording — the chip simply names its target until there is a result to show.
  const plainTip = isChallenge && chip.challengedTeamName
    ? `${chip.chipName} — challenging ${chip.challengedTeamName}`
    : chip.chipName;

  const tip = match ? <ChallengeSummary match={match} /> : plainTip;

  const pill = (
    <span
      className="block truncate rounded bg-yellow-400/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-yellow-300 whitespace-nowrap"
      aria-label={typeof tip === "string" ? tip : `${chip.chipName} — view challenge result`}
    >
      {chip.chipCode}
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
function ChallengeSummary({ match }: { match: ChallengeMatch }) {
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

  return (
    <div className="w-[min(88vw,392px)]">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">
        Challenge Chip · GW{match.gameweek}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-white">
        <span className="truncate">{match.challengerTeamName}</span>
        <span className="shrink-0 font-bold">
          {match.challengerScore} – {match.challengedScore}
        </span>
        <span className="truncate text-right">{match.challengedTeamName}</span>
      </div>
      <div className="mt-1 text-[11px] font-semibold text-yellow-300">
        {challengeOutcomeLabel(match)}
      </div>
      {/* No chips props: renders the standard breakdown WITHOUT the TVT chip rows. */}
      <PlayerBreakdown fixture={challengeFixture} />
      <div className="mt-1.5 text-[9px] leading-snug text-gray-500">
        Chip points only — the challenge does not count toward matches played or won.
      </div>
    </div>
  );
}
