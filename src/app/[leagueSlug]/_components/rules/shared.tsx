"use client";

import type { ReactNode } from "react";

export interface LeagueConfig {
  teamSize: number;
  leagueStageEnd: number;
  leagueName: string;
  enabledChips: string[];
}

export const CHIP_INFO: Record<string, { label: string; color: string; tagline: string; description: string }> = {
  W: {
    label: "Win-Win",
    color: "text-green-400",
    tagline: "+2 league points, guaranteed",
    description:
      "Earn +2 league points regardless of your match result. If you have net negative transfer hits in that GW, the chip is wasted (counted as used, no points awarded). Best played when you need a guaranteed return.",
  },
  D: {
    label: "Double Pointer",
    color: "text-purple-400",
    tagline: "Double your match points",
    description:
      "Doubles your TVT league points for that gameweek: Win = +4 pts, Draw = +2 pts, Loss = 0 pts. Best played in a week you are confident of winning.",
  },
  C: {
    label: "Challenge Chip",
    color: "text-orange-400",
    tagline: "Challenge a top-2 team from the opposite group",
    description:
      "Creates an extra head-to-head fixture against one of the top-2 ranked teams from the opposite group (32-team only). Win the challenge to earn +2 extra league points. No deduction for losing.",
  },
  SL: {
    label: "Score Lock",
    color: "text-blue-400",
    tagline: "Lock in your season average as a floor",
    description:
      "At the time you play this chip, your season average (total FPL points ÷ GWs played) is recorded. If your actual GW score is below that average, the average is used instead for the match calculation. Protects against a bad gameweek.",
  },
  CB: {
    label: "Comeback",
    color: "text-yellow-400",
    tagline: "+1 bonus point for bouncing back",
    description:
      "If you lost the previous gameweek and win this gameweek, you earn +1 extra league point. Must be played before the GW deadline. No benefit if you won or drew last week.",
  },
  UD: {
    label: "Underdog",
    color: "text-red-400",
    tagline: "+1 bonus point for the upset",
    description:
      "If you are ranked 3 or more places below your opponent and you win, you earn +1 extra league point. Rank snapshot is taken at processing time. Rewards upsets against higher-ranked opponents.",
  },
};

export function getChipSetLabel(_teamSize: number, leagueStageEnd: number): { set1: string; set2: string } {
  const playoffStartGw = leagueStageEnd + 1;
  const midpoint = Math.ceil((playoffStartGw - 1) / 2);
  return {
    set1: `GW1 – GW${midpoint}`,
    set2: `GW${midpoint + 1} – GW${leagueStageEnd}`,
  };
}

export function formatPayout(amount: number): string {
  if (amount >= 1_000_000) return `£${(amount / 1_000_000).toFixed(amount % 1_000_000 === 0 ? 0 : 1)}M`;
  return `£${(amount / 1_000).toFixed(0)}K`;
}

export function SectionHeader({ letter, color, title }: { letter: string; color: string; title: string }) {
  const colorMap: Record<string, string> = {
    purple: "bg-purple-500/20 text-purple-400",
    orange: "bg-orange-500/20 text-orange-400",
    green: "bg-green-500/20 text-green-400",
    yellow: "bg-yellow-500/20 text-yellow-400",
    red: "bg-red-500/20 text-red-400",
    blue: "bg-blue-500/20 text-blue-400",
  };
  return (
    <div className="flex items-center gap-3 mb-6">
      <span className={`flex h-10 w-10 items-center justify-center rounded-lg text-lg font-bold shrink-0 ${colorMap[color] ?? colorMap.purple}`}>
        {letter}
      </span>
      <h2 className="text-xl sm:text-2xl font-bold text-white">{title}</h2>
    </div>
  );
}

export function RuleItem({ children, accent = "yellow" }: { children: ReactNode; accent?: string }) {
  const dotColors: Record<string, string> = {
    yellow: "text-yellow-400",
    purple: "text-purple-400",
  };
  return (
    <li className="flex gap-3">
      <span className={`shrink-0 ${dotColors[accent] ?? dotColors.yellow}`}>•</span>
      <span>{children}</span>
    </li>
  );
}

export function ChipsSection({ enabledChips, chipSets, note }: { enabledChips: string[]; chipSets: { set1: string; set2: string }; note?: string }) {
  const chips = enabledChips.length > 0 ? enabledChips : ["D", "W", "C"];
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
      <SectionHeader letter="D" color="yellow" title="TVT Special Chips" />
      <p className="text-gray-400 mb-2">
        Each team gets <strong className="text-white">one of each chip per set</strong> and cannot use the same chip type twice in the same set.
      </p>
      <div className="flex flex-wrap gap-4 mb-6 text-sm">
        <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-2">
          <span className="text-gray-400">Set 1: </span>
          <span className="text-yellow-400 font-semibold">{chipSets.set1}</span>
        </div>
        <div className="rounded-lg bg-white/5 border border-white/10 px-4 py-2">
          <span className="text-gray-400">Set 2: </span>
          <span className="text-yellow-400 font-semibold">{chipSets.set2}</span>
        </div>
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2 text-red-400">
          Playoffs: No chips
        </div>
      </div>
      <div className="space-y-4">
        {chips.map((code) => {
          const info = CHIP_INFO[code];
          if (!info) return null;
          return (
            <div key={code} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className={`font-bold text-base ${info.color}`}>{info.label}</span>
                <span className="text-xs bg-white/10 rounded-full px-2 py-0.5 text-gray-400">{code}</span>
                <span className="text-gray-400 text-sm italic">{info.tagline}</span>
              </div>
              <p className="text-gray-300 text-sm leading-relaxed">{info.description}</p>
            </div>
          );
        })}
      </div>
      {note && (
        <div className="mt-4 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 text-sm">
          {note}
        </div>
      )}
      <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
        <strong>Chip Penalty:</strong> Claiming a chip you do not have results in a −8 point deduction.
      </div>
    </section>
  );
}

export function HitsAndBonusSection() {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
      <SectionHeader letter="E" color="red" title="Negative Hits & Bonus Points" />
      <ul className="space-y-4 text-gray-300">
        <RuleItem>
          <strong>Negative Hit Cap:</strong> Maximum −12 points per player per GW. Exceeding this triggers a −1 league point deduction for the team.
        </RuleItem>
        <RuleItem>
          <strong>Bonus Point (BP):</strong> Awarded if a team wins by 75+ points AND has the highest winning margin in their group for that GW.
        </RuleItem>
        <RuleItem>
          <strong>Tiebreaker fallback:</strong> BP is included in the CP/BP column and used as the second tiebreaker after league points.
        </RuleItem>
      </ul>
    </section>
  );
}

export function TiebreakerSection() {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
      <SectionHeader letter="F" color="blue" title="Tiebreaker Hierarchy" />
      <p className="text-gray-400 mb-6">When teams are equal on league points:</p>
      <div className="grid sm:grid-cols-2 gap-6">
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h3 className="text-base font-semibold text-green-400 mb-3">League Stage</h3>
          <ol className="space-y-2 text-gray-300 text-sm list-decimal list-inside">
            <li>Total League Points</li>
            <li>Most Wins</li>
            <li>Head-to-Head result</li>
            <li>CP/BP (Chip &amp; Bonus Points)</li>
            <li>Total FPL Score (Points For)</li>
          </ol>
        </div>
        <div className="p-4 rounded-lg bg-white/5 border border-white/10">
          <h3 className="text-base font-semibold text-purple-400 mb-3">Play-offs (aggregate tie)</h3>
          <ol className="space-y-2 text-gray-300 text-sm list-decimal list-inside">
            <li>Higher Leg 2 score</li>
            <li>TVT Captain&apos;s Points</li>
            <li>TVT Captain&apos;s FPL Captain Points</li>
            <li>Partner&apos;s FPL Captain Points</li>
            <li>FPL Vice-Captain Points</li>
            <li>League Stage Rank</li>
          </ol>
        </div>
      </div>
    </section>
  );
}
