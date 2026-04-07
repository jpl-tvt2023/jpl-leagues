"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

interface LeagueConfig {
  teamSize: number;
  leagueStageEnd: number; // = playoffStartGw - 1
  leagueName: string;
  enabledChips: string[];
}

const CHIP_INFO: Record<string, { label: string; color: string; tagline: string; description: string }> = {
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

function getChipSetLabel(teamSize: number, leagueStageEnd: number): { set1: string; set2: string } {
  const playoffStartGw = leagueStageEnd + 1;
  const midpoint = Math.ceil((playoffStartGw - 1) / 2);
  return {
    set1: `GW1 – GW${midpoint}`,
    set2: `GW${midpoint + 1} – GW${leagueStageEnd}`,
  };
}

function get32TeamRules(cfg: LeagueConfig) {
  const chipSets = getChipSetLabel(cfg.teamSize, cfg.leagueStageEnd);
  return (
    <div className="space-y-8">
      {/* A — Structure */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="A" color="purple" title="Team Structure" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem>
            <strong>Format:</strong> 32 teams split into 2 groups (Group A &amp; Group B) of 16 teams each.
          </RuleItem>
          <RuleItem>
            <strong>Squad:</strong> 2 FPL managers per team. Teams play every other team in their group twice (home &amp; away) — 30 matches in the League Stage.
          </RuleItem>
          <RuleItem>
            <strong>Naming:</strong> Team name must follow <code className="bg-white/10 px-2 py-0.5 rounded text-xs">Abbreviation — Player Name</code> (e.g., DM — Rahul).
          </RuleItem>
          <RuleItem>
            <strong>Penalty:</strong> Incorrect naming forces the lowest-scoring partner as captain that GW.
          </RuleItem>
          <RuleItem>
            <strong>FPL League:</strong> Both players must join the official admin FPL league before the first deadline.
          </RuleItem>
        </ul>
      </section>

      {/* B — Scoring */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="orange" title="Scoring & Captaincy" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Match Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Team Score:</strong> Combined FPL score of both players minus transfer hits. Negative hits reduce the score directly.</RuleItem>
          <RuleItem><strong>Captain:</strong> One player is nominated as captain per GW. Their net score (FPL score minus hits) is <strong>doubled</strong>.</RuleItem>
          <RuleItem><strong>Captain Deadline:</strong> Captain must be announced in the WhatsApp group 1 second before the official FPL deadline (e.g., 4:29:59 PM).</RuleItem>
          <RuleItem><strong>Captaincy Limit (League Stage):</strong> Each player has 15 captain chips. Once used up, they cannot be captain again until the Play-offs.</RuleItem>
          <RuleItem><strong>Announcement Penalty:</strong> Spamming or modifying other teams&apos; entries = −1 league point (GW1–30) or −8 score (GW31+).</RuleItem>
        </ul>
      </section>

      {/* C — Phases */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="C" color="green" title="The Two Phases" />
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 1: League Stage (GW1 – GW30)</h3>
          <ul className="space-y-3 text-gray-300 ml-2">
            <RuleItem accent="purple">Each team plays 30 head-to-head matches (every group opponent twice).</RuleItem>
            <RuleItem accent="purple"><strong>Qualification cutoffs (per group):</strong></RuleItem>
            <li className="ml-6 space-y-1 text-sm">
              <div className="text-green-400 font-medium">Rank 1–8 → TVT Title Play-offs</div>
              <div className="text-yellow-400 font-medium">Rank 9–14 → Challenger Series</div>
              <div className="text-red-400 font-medium">Rank 15–16 → Eliminated</div>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 2: Play-offs (GW31 – GW38)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-gray-300 min-w-[480px]">
              <thead>
                <tr className="border-b border-white/10 text-xs text-gray-400">
                  <th className="px-3 py-2 text-left">GW</th>
                  <th className="px-3 py-2 text-left">Title Path</th>
                  <th className="px-3 py-2 text-left">Challenger Path</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["GW31–32", "Round of 16 (2-legged)", "C-31 (KO)"],
                  ["GW33–34", "Quarter-Finals (2-legged)", "C-32 → C-33 Survival"],
                  ["GW35–36", "Semi-Finals (2-legged)", "C-34 → C-35"],
                  ["GW37–38", "Final (2-legged)", "C-36 → C-37 → C-38 Final"],
                ].map(([gw, title, chal]) => (
                  <tr key={gw} className="border-b border-white/5">
                    <td className="px-3 py-2 text-yellow-400 font-mono text-xs">{gw}</td>
                    <td className="px-3 py-2 text-green-300">{title}</td>
                    <td className="px-3 py-2 text-yellow-300">{chal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-4 space-y-2 text-gray-300 ml-2">
            <RuleItem accent="purple"><strong>RO16 Seeding (cross-group):</strong> A1 vs B8, A2 vs B7 … A8 vs B1. QF seeding follows RO16 results.</RuleItem>
            <RuleItem accent="purple"><strong>2-legged ties:</strong> Higher aggregate score advances. On aggregate draw, higher Leg 2 score advances.</RuleItem>
            <RuleItem accent="purple"><strong>Challenger C-33:</strong> Survival format — individual scores, bottom teams eliminated each round.</RuleItem>
            <RuleItem accent="purple"><strong>Playoffs captaincy:</strong> Unlimited — any player can captain any number of times.</RuleItem>
          </ul>
        </div>
      </section>

      {/* D — Chips */}
      <ChipsSection enabledChips={cfg.enabledChips} chipSets={chipSets} />

      {/* E — Hits & Bonus */}
      <HitsAndBonusSection />

      {/* F — Tiebreakers */}
      <TiebreakerSection />
    </div>
  );
}

function get16TeamRules(cfg: LeagueConfig) {
  const chipSets = getChipSetLabel(cfg.teamSize, cfg.leagueStageEnd);
  return (
    <div className="space-y-8">
      {/* A */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="A" color="purple" title="Team Structure" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem>
            <strong>Format:</strong> 16 teams in a single group. No A/B split.
          </RuleItem>
          <RuleItem>
            <strong>Squad:</strong> 2 FPL managers per team. Each team plays every other team twice — 30 matches in the League Stage.
          </RuleItem>
          <RuleItem>
            <strong>Naming:</strong> Team name must follow <code className="bg-white/10 px-2 py-0.5 rounded text-xs">Abbreviation — Player Name</code>.
          </RuleItem>
          <RuleItem>
            <strong>FPL League:</strong> Both players must join the official admin FPL league before the first deadline.
          </RuleItem>
        </ul>
      </section>

      {/* B */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="orange" title="Scoring & Captaincy" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Match Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Team Score:</strong> Combined FPL score of both players minus transfer hits. Captain&apos;s net score is <strong>doubled</strong>.</RuleItem>
          <RuleItem><strong>Captain Deadline:</strong> Announced in WhatsApp 1 second before official FPL deadline.</RuleItem>
          <RuleItem><strong>Captaincy Limit (League Stage):</strong> 15 captain chips per player. Exhausted players cannot captain again until the Play-offs.</RuleItem>
          <RuleItem><strong>Announcement Penalty:</strong> Spamming = −1 league point (GW1–30) or −8 score (GW31+).</RuleItem>
        </ul>
      </section>

      {/* C */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="C" color="green" title="The Two Phases" />
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 1: League Stage (GW1 – GW30)</h3>
          <ul className="space-y-3 text-gray-300 ml-2">
            <RuleItem accent="purple">30 head-to-head matches per team (every opponent twice).</RuleItem>
            <RuleItem accent="purple"><strong>Qualification:</strong></RuleItem>
            <li className="ml-6 space-y-1 text-sm">
              <div className="text-green-400 font-medium">Rank 1–8 → TVT Title Play-offs (QF)</div>
              <div className="text-yellow-400 font-medium">Rank 9–14 → Challenger Series</div>
              <div className="text-red-400 font-medium">Rank 15–16 → Eliminated</div>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 2: Play-offs (GW31 – GW36)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-gray-300 min-w-[480px]">
              <thead>
                <tr className="border-b border-white/10 text-xs text-gray-400">
                  <th className="px-3 py-2 text-left">GW</th>
                  <th className="px-3 py-2 text-left">Title Path</th>
                  <th className="px-3 py-2 text-left">Challenger Path</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["GW31–32", "Quarter-Finals (2-legged)", "C-31 (single-leg: 9v14, 10v13, 11v12)"],
                  ["GW33–34", "Semi-Finals (2-legged)", "C-32 → C-33 Survival (+ QF losers)"],
                  ["GW35–36", "Final (2-legged)", "C-34 → C-35 → C-36 Final"],
                ].map(([gw, title, chal]) => (
                  <tr key={gw} className="border-b border-white/5">
                    <td className="px-3 py-2 text-yellow-400 font-mono text-xs">{gw}</td>
                    <td className="px-3 py-2 text-green-300">{title}</td>
                    <td className="px-3 py-2 text-yellow-300">{chal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-4 space-y-2 text-gray-300 ml-2">
            <RuleItem accent="purple"><strong>QF Seeding:</strong> 1v8, 2v7, 3v6, 4v5 (within single group).</RuleItem>
            <RuleItem accent="purple"><strong>2-legged ties:</strong> Higher aggregate advances; on draw, higher Leg 2 score advances.</RuleItem>
            <RuleItem accent="purple"><strong>C-33 Survival:</strong> QF losers join remaining Challenger teams; bottom teams eliminated by individual score.</RuleItem>
          </ul>
        </div>
      </section>

      {/* D — Chips */}
      <ChipsSection enabledChips={cfg.enabledChips} chipSets={chipSets} note="Challenge Chip (if enabled) targets the top-2 of the single group." />

      {/* E */}
      <HitsAndBonusSection />

      {/* F */}
      <TiebreakerSection />
    </div>
  );
}

function get8TeamRules(cfg: LeagueConfig) {
  const chipSets = getChipSetLabel(cfg.teamSize, cfg.leagueStageEnd);
  return (
    <div className="space-y-8">
      {/* A */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="A" color="purple" title="Team Structure" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem>
            <strong>Format:</strong> 8 teams in a single group. No A/B split.
          </RuleItem>
          <RuleItem>
            <strong>Squad:</strong> 2 FPL managers per team. A 5× round-robin is played — every team faces every other team 5 times, for 35 matches across the League Stage.
          </RuleItem>
          <RuleItem>
            <strong>Naming:</strong> Team name must follow <code className="bg-white/10 px-2 py-0.5 rounded text-xs">Abbreviation — Player Name</code>.
          </RuleItem>
          <RuleItem>
            <strong>FPL League:</strong> Both players must join the official admin FPL league before the first deadline.
          </RuleItem>
        </ul>
      </section>

      {/* B */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="orange" title="Scoring & Captaincy" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Match Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Team Score:</strong> Combined FPL score of both players minus transfer hits. Captain&apos;s net score is <strong>doubled</strong>.</RuleItem>
          <RuleItem><strong>Captain Deadline:</strong> Announced in WhatsApp 1 second before official FPL deadline.</RuleItem>
          <RuleItem><strong>Captaincy Limit (League Stage):</strong> 15 captain chips per player. Once exhausted, that player cannot captain again until Play-offs.</RuleItem>
          <RuleItem><strong>Announcement Penalty:</strong> Spamming = −1 league point (GW1–35) or −8 score (GW36+).</RuleItem>
        </ul>
      </section>

      {/* C */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="C" color="green" title="The Two Phases" />
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 1: League Stage (GW1 – GW35)</h3>
          <ul className="space-y-3 text-gray-300 ml-2">
            <RuleItem accent="purple">35 head-to-head matches per team (5 full round-robins).</RuleItem>
            <RuleItem accent="purple"><strong>Qualification:</strong></RuleItem>
            <li className="ml-6 space-y-1 text-sm">
              <div className="text-green-400 font-medium">Rank 1–4 → Title Play-offs (Semi-Finals)</div>
              <div className="text-red-400 font-medium">Rank 5–8 → Eliminated (no Challenger Series)</div>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 2: Play-offs (GW36 – GW38)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-gray-300 min-w-[400px]">
              <thead>
                <tr className="border-b border-white/10 text-xs text-gray-400">
                  <th className="px-3 py-2 text-left">GW</th>
                  <th className="px-3 py-2 text-left">Match</th>
                  <th className="px-3 py-2 text-left">Format</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["GW36", "Semi-Final A (1 vs 4)", "Single-leg"],
                  ["GW36", "Semi-Final B (2 vs 3)", "Single-leg"],
                  ["GW37", "3rd Place Match (SF losers)", "Single-leg"],
                  ["GW37", "Final — Leg 1 (SF winners)", "First leg"],
                  ["GW38", "Final — Leg 2", "Second leg (aggregate)"],
                ].map(([gw, match, fmt], i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="px-3 py-2 text-yellow-400 font-mono text-xs">{gw}</td>
                    <td className="px-3 py-2 text-green-300">{match}</td>
                    <td className="px-3 py-2 text-gray-400">{fmt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-4 space-y-2 text-gray-300 ml-2">
            <RuleItem accent="purple"><strong>Semi-Finals:</strong> Single-leg — higher score advances.</RuleItem>
            <RuleItem accent="purple"><strong>Final:</strong> 2-legged — higher aggregate wins. On aggregate draw, higher Leg 2 score wins.</RuleItem>
            <RuleItem accent="purple"><strong>3rd place match:</strong> Single-leg between the two SF losers.</RuleItem>
            <RuleItem accent="purple"><strong>Playoffs captaincy:</strong> Unlimited — any player can captain any number of times.</RuleItem>
          </ul>
        </div>
      </section>

      {/* D — Chips */}
      <ChipsSection enabledChips={cfg.enabledChips} chipSets={chipSets} note="No chips can be played during the playoff phase (GW36–38). Challenge Chip is not available in the 8-team format." />

      {/* E */}
      <HitsAndBonusSection />

      {/* F */}
      <TiebreakerSection />
    </div>
  );
}

function getTripleCrownRules(cfg: LeagueConfig) {
  const leagueStageEnd = cfg.leagueStageEnd;
  return (
    <div className="space-y-8">
      {/* A — Structure */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="A" color="purple" title="League Structure" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Format:</strong> 20 teams compete across 3 parallel competitions — Premier League (PL), Cup Groups (UEFA), and UCL/UEL Knockouts.</RuleItem>
          <RuleItem><strong>Squad:</strong> 2 FPL managers per team. Team score = combined FPL scores of both players minus transfer hits.</RuleItem>
          <RuleItem><strong>Captaincy:</strong> One player is nominated as captain per GW. Their net score (FPL score minus hits) is <strong>doubled</strong>. Same deadline and rules as TVT.</RuleItem>
          <RuleItem><strong>No Chips:</strong> Triple Crown does not use any special chips (Win-Win, Double Pointer, Challenge, etc.).</RuleItem>
        </ul>
      </section>

      {/* B — PL */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="orange" title="Premier League (PL)" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Duration:</strong> All 38 gameweeks. Every team plays every other team twice (home &amp; away) — 38 matches total.</RuleItem>
          <RuleItem><strong>Match Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Scoring:</strong> Combined FPL score of both players minus transfer hits. Captain&apos;s net score is doubled.</RuleItem>
          <RuleItem><strong>Standings:</strong> Teams are ranked by total league points. PL standings after GW5 determine cup group seeding.</RuleItem>
        </ul>
      </section>

      {/* C — Cup Groups */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="C" color="green" title="Cup Groups (UEFA)" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Seeding:</strong> After GW5, the 20 teams are snake-seeded into 4 cup groups (A/B/C/D) of 5 teams each, based on PL standings. Rank 1 gets the easiest group.</RuleItem>
          <RuleItem><strong>Ghost Teams:</strong> Each group has a 6th &quot;Ghost&quot; team. One team plays the Ghost each matchday. The Ghost&apos;s score = average of the other 4 human teams in the group (rounded up).</RuleItem>
          <RuleItem><strong>Schedule:</strong> 10 matchdays on even GWs: 6, 8, 10, 12, 14, 16, 18, 20, 22, 24. Each team plays every group opponent twice (including the Ghost).</RuleItem>
          <RuleItem><strong>Cup Points:</strong> Win = 3 pts, Draw = 1 pt, Loss = 0 pts (football-style table).</RuleItem>
          <RuleItem><strong>Qualification:</strong> Top 2 from each group qualify for UCL. Ranks 3–4 qualify for UEL.</RuleItem>
        </ul>
      </section>

      {/* D — UCL/UEL Knockouts */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="D" color="blue" title="UCL / UEL Knockouts" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>UCL (Champions League):</strong> 8 teams (top 2 from each cup group). Quarter-Finals → Semi-Finals → Final.</RuleItem>
          <RuleItem><strong>UEL (Europa League):</strong> 8 teams (ranks 3–4 from each cup group). Quarter-Finals → Semi-Finals → Final.</RuleItem>
          <RuleItem><strong>Format:</strong> 2-legged ties. Aggregate score over both legs decides the winner.</RuleItem>
          <RuleItem><strong>QF Seeding (cross-group):</strong></RuleItem>
          <li className="ml-8 space-y-1 text-sm">
            <div className="text-blue-400 font-medium">UCL: A1 vs C2, A2 vs C1, B1 vs D2, B2 vs D1</div>
            <div className="text-orange-400 font-medium">UEL: A3 vs C4, A4 vs C3, B3 vs D4, B4 vs D3</div>
          </li>
          <RuleItem><strong>Scoring:</strong> Same as PL — combined FPL score minus hits, captain doubled. Each leg is scored independently.</RuleItem>
        </ul>
      </section>

      {/* E — Hits & Tiebreakers */}
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="E" color="yellow" title="Transfer Hits & Tiebreakers" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Transfer Hits:</strong> Each FPL transfer beyond the free allowance costs −4 points. These are deducted from the player&apos;s score before captain doubling.</RuleItem>
          <RuleItem><strong>PL Tiebreaker:</strong> Total FPL score (higher is better), then head-to-head record.</RuleItem>
          <RuleItem><strong>Cup Group Tiebreaker:</strong> Goal difference (total points scored for minus against), then total points scored.</RuleItem>
          <RuleItem><strong>Knockout Tiebreaker:</strong> If aggregate is tied after 2 legs, the team with the higher single-leg score wins. If still tied, the higher-seeded team advances.</RuleItem>
        </ul>
      </section>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function SectionHeader({ letter, color, title }: { letter: string; color: string; title: string }) {
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

function RuleItem({ children, accent = "yellow" }: { children: React.ReactNode; accent?: string }) {
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

function ChipsSection({ enabledChips, chipSets, note }: { enabledChips: string[]; chipSets: { set1: string; set2: string }; note?: string }) {
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

function HitsAndBonusSection() {
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

function TiebreakerSection() {
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LeagueRulesPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [config, setConfig] = useState<LeagueConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [dashboardHref, setDashboardHref] = useState("/dashboard");
  const [leagueName, setLeagueName] = useState<string>("");
  const [leagueFormat, setLeagueFormat] = useState<string | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        setIsLoggedIn(res.ok && data.authenticated && (data.type === "team" || data.type === "admin" || data.type === "superadmin"));
        if (data.type === "admin" && data.adminLeagueId) setDashboardHref(`/admin/${data.adminLeagueId}`);
        else if (data.type === "superadmin") setDashboardHref("/admin");
      } catch {
        setIsLoggedIn(false);
      }
    };
    checkAuth();
  }, []);

  useEffect(() => {
    if (!leagueSlug) return;

    const fetchConfig = async () => {
      try {
        // Fetch leagues to get league config (name, chips, playoffStartGw, teamSize)
        const leaguesRes = await fetch("/api/leagues");
        const leaguesData = await leaguesRes.json();
        const league = (leaguesData.leagues || []).find((l: any) => l.slug === leagueSlug);

        if (league) {
          setLeagueName(league.name);
          setLeagueFormat(league.format ?? null);

          // Parse enabledChips from league (it's stored as JSON string)
          let enabledChips: string[] = ["D", "W", "C"];
          try {
            if (league.enabledChips) {
              enabledChips = JSON.parse(league.enabledChips);
            }
          } catch { /* keep default */ }

          const leagueStageEnd = (league.playoffStartGw ?? 31) - 1;
          const teamSize = league.teamSize ?? 32;

          setConfig({ teamSize, leagueStageEnd, leagueName: league.name, enabledChips });
        } else {
          // Fallback to standings API if league not found (shouldn't happen)
          const standingsRes = await fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`);
          const standingsData = await standingsRes.json();
          const teamSize = standingsData.teamSize ?? 32;
          const leagueStageEnd = standingsData.leagueStageEnd ?? 30;
          const enabledChips = standingsData.enabledChips ?? ["D", "W", "C"];
          setConfig({ teamSize, leagueStageEnd, leagueName: "", enabledChips });
        }
      } catch (error) {
        console.error("Failed to fetch league config:", error);
        setConfig({ teamSize: 32, leagueStageEnd: 30, leagueName: "", enabledChips: ["D", "W", "C"] });
      } finally {
        setIsLoading(false);
      }
    };

    fetchConfig();
  }, [leagueSlug]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const isTripleCrown = leagueFormat === "triple-crown";

  const variantLabel = isTripleCrown
    ? "Triple Crown (20 Teams)"
    : config?.teamSize === 8
    ? "8-Team Format"
    : config?.teamSize === 16
    ? "16-Team Format"
    : "32-Team Format";

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
          <Link href={isLoggedIn ? dashboardHref : "/"} className="text-gray-300 hover:text-white transition">{isLoggedIn ? "Dashboard" : "All Leagues"}</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">
            {isTripleCrown ? "PL Standings" : "Standings"}
          </Link>
          <Link href={`/${leagueSlug}/fixtures`} className="text-gray-300 hover:text-white transition">
            {isTripleCrown ? "PL Fixtures" : "Fixtures"}
          </Link>
          {isTripleCrown ? (
            <>
              <Link href={`/${leagueSlug}/uefa-standings`} className="text-gray-300 hover:text-white transition">UEFA Standings</Link>
              <Link href={`/${leagueSlug}/uefa-fixtures`} className="text-gray-300 hover:text-white transition">UEFA Fixtures</Link>
              <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">Playoffs</Link>
            </>
          ) : (
            <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">Playoffs</Link>
          )}
          <Link href={`/${leagueSlug}/winners`} className="text-gray-300 hover:text-white transition">Winners</Link>
          <Link href={`/${leagueSlug}/rules`} className="text-yellow-400 font-semibold transition">Rules</Link>
          <Link href={`/${leagueSlug}/help`} className="text-gray-300 hover:text-white transition">Help</Link>
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

      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-10">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-3">{isTripleCrown ? "Triple Crown Rules & Regulations" : "TVT Rules & Regulations"}</h1>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <p className="text-gray-400">{leagueName || leagueSlug}</p>
            {!isLoading && config && (
              <span className="rounded-full bg-purple-500/20 border border-purple-500/30 px-3 py-0.5 text-purple-300 text-xs font-semibold">
                {variantLabel}
              </span>
            )}
          </div>
        </div>

        {isLoading ? (
          <LoadingScreen variant="rules" fullScreen={false} />
        ) : config ? (
          isTripleCrown
            ? getTripleCrownRules(config)
            : config.teamSize === 8
            ? get8TeamRules(config)
            : config.teamSize === 16
            ? get16TeamRules(config)
            : get32TeamRules(config)
        ) : (
          <div className="text-center text-red-400 py-12">Could not load league configuration.</div>
        )}
      </div>
    </div>
  );
}
