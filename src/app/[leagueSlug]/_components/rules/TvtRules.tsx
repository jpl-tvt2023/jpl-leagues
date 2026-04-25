"use client";

import {
  ChipsSection,
  HitsAndBonusSection,
  type LeagueConfig,
  RuleItem,
  SectionHeader,
  TiebreakerSection,
  getChipSetLabel,
} from "./shared";

export function TvtRules({ config }: { config: LeagueConfig }) {
  if (config.teamSize === 8) return <Tvt8 config={config} />;
  if (config.teamSize === 16) return <Tvt16 config={config} />;
  return <Tvt32 config={config} />;
}

function Tvt32({ config }: { config: LeagueConfig }) {
  const chipSets = getChipSetLabel(config.teamSize, config.leagueStageEnd);
  const captaincyLimit = Math.ceil(config.leagueStageEnd / 2);
  return (
    <div className="space-y-8">
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
            <strong>FPL League:</strong> Both players must join the official admin FPL league before the first deadline.
          </RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="orange" title="Scoring & Captaincy" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Match Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Team Score:</strong> Combined FPL score of both players minus transfer hits. Negative hits reduce the score directly.</RuleItem>
          <RuleItem><strong>Captain:</strong> One player is nominated as captain per GW. Their net score (FPL score minus hits) is <strong>doubled</strong>.</RuleItem>
          <RuleItem><strong>Captaincy Limit (League Stage):</strong> Each player has {captaincyLimit} captain chips. Once used up, they cannot be captain again until the Play-offs.</RuleItem>
        </ul>
      </section>

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

      <ChipsSection enabledChips={config.enabledChips} chipSets={chipSets} />
      <HitsAndBonusSection />
      <TiebreakerSection />
    </div>
  );
}

function Tvt16({ config }: { config: LeagueConfig }) {
  const chipSets = getChipSetLabel(config.teamSize, config.leagueStageEnd);
  const captaincyLimit = Math.ceil(config.leagueStageEnd / 2);
  return (
    <div className="space-y-8">
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
            <strong>FPL League:</strong> Both players must join the official admin FPL league before the first deadline.
          </RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="orange" title="Scoring & Captaincy" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Match Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Team Score:</strong> Combined FPL score of both players minus transfer hits. Captain&apos;s net score is <strong>doubled</strong>.</RuleItem>
          <RuleItem><strong>Captaincy Limit (League Stage):</strong> {captaincyLimit} captain chips per player. Exhausted players cannot captain again until the Play-offs.</RuleItem>
        </ul>
      </section>

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

      <ChipsSection enabledChips={config.enabledChips} chipSets={chipSets} note="Challenge Chip (if enabled) targets the top-2 of the single group." />
      <HitsAndBonusSection />
      <TiebreakerSection />
    </div>
  );
}

function Tvt8({ config }: { config: LeagueConfig }) {
  const chipSets = getChipSetLabel(config.teamSize, config.leagueStageEnd);
  const captaincyLimit = Math.ceil(config.leagueStageEnd / 2);
  return (
    <div className="space-y-8">
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
            <strong>FPL League:</strong> Both players must join the official admin FPL league before the first deadline.
          </RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="orange" title="Scoring & Captaincy" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Match Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Team Score:</strong> Combined FPL score of both players minus transfer hits. Captain&apos;s net score is <strong>doubled</strong>.</RuleItem>
          <RuleItem><strong>Captaincy Limit (League Stage):</strong> {captaincyLimit} captain chips per player. Once exhausted, that player cannot captain again until Play-offs.</RuleItem>
        </ul>
      </section>

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

      <ChipsSection enabledChips={config.enabledChips} chipSets={chipSets} note="No chips can be played during the playoff phase (GW36–38)." />
      <HitsAndBonusSection />
      <TiebreakerSection />
    </div>
  );
}
