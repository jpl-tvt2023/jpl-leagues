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
            <table className="w-full text-sm text-gray-300 min-w-[560px]">
              <thead>
                <tr className="border-b border-white/10 text-xs text-gray-400">
                  <th className="px-3 py-2 text-left">GW</th>
                  <th className="px-3 py-2 text-left">Title Path</th>
                  <th className="px-3 py-2 text-left">Challenger Path</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["GW31", "RO16 — Leg 1", "C-31: 6 single-leg KO ties (ranks 9–14 cross-group, 12 teams)"],
                  ["GW32", "RO16 — Leg 2 (resolve aggregate)", "C-32: 3 single-leg KO ties (6 C-31 winners)"],
                  ["GW33", "QF — Leg 1", "C-33 Survival: 8 RO16 losers + 3 C-32 winners ranked by FPL points; top 8 advance"],
                  ["GW34", "QF — Leg 2 (resolve aggregate)", "C-34: 4 single-leg KO ties (Survival top 8: 1v8, 2v7, 3v6, 4v5)"],
                  ["GW35", "SF — Leg 1", "C-35: 4 single-leg KO ties (4 QF losers vs 4 C-34 winners)"],
                  ["GW36", "SF — Leg 2 (resolve aggregate)", "C-36: 2 single-leg KO ties (4 C-35 winners)"],
                  ["GW37", "Final — Leg 1", "C-37: 2 single-leg KO ties (2 SF losers vs 2 C-36 winners)"],
                  ["GW38", "Final — Leg 2 (Champion crowned)", "C-38: Challenger Final — single-leg (2 C-37 winners)"],
                ].map(([gw, title, chal]) => (
                  <tr key={gw} className="border-b border-white/5">
                    <td className="px-3 py-2 text-yellow-400 font-mono text-xs whitespace-nowrap">{gw}</td>
                    <td className="px-3 py-2 text-green-300">{title}</td>
                    <td className="px-3 py-2 text-yellow-300">{chal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-4 space-y-2 text-gray-300 ml-2">
            <RuleItem accent="purple"><strong>RO16 Seeding (cross-group):</strong> A1 vs B8, A2 vs B7 … A8 vs B1, plus the mirror B1 vs A8 … B8 vs A1 — 8 ties total.</RuleItem>
            <RuleItem accent="purple"><strong>QF Seeding:</strong> Follows RO16 bracket positions — RO16-A winner vs RO16-H winner, B vs G, C vs F, D vs E (4 ties, 2-legged across GW33–34).</RuleItem>
            <RuleItem accent="purple"><strong>2-legged ties:</strong> Higher aggregate advances. On aggregate draw, higher Leg 2 score advances. The home team in Leg 1 plays away in Leg 2.</RuleItem>
            <RuleItem accent="purple"><strong>Challenger Survival (GW33):</strong> 8 RO16 losers and 3 C-32 winners (11 teams) play their normal GW33 — ranked by FPL net points; top 8 advance into C-34, bottom 3 are eliminated.</RuleItem>
            <RuleItem accent="purple"><strong>Single-leg KO ties:</strong> On a tied score, the home team advances.</RuleItem>
            <RuleItem accent="purple"><strong>Eliminated after GW30:</strong> Group ranks 15–16 (4 teams total) — no playoff matches.</RuleItem>
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
            <RuleItem accent="purple">30 head-to-head matches per team (every opponent twice). No eliminations — all 16 teams continue into the Play-offs.</RuleItem>
            <RuleItem accent="purple"><strong>Track allocation after GW30:</strong></RuleItem>
            <li className="ml-6 space-y-1 text-sm">
              <div className="text-green-400 font-medium">Rank 1–8 → Championship Track</div>
              <div className="text-yellow-400 font-medium">Rank 9–16 → Challenger Track</div>
            </li>
          </ul>
        </div>
        <div>
          <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 2: Play-offs (GW31 – GW38)</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-gray-300 min-w-[640px]">
              <thead>
                <tr className="border-b border-white/10 text-xs text-gray-400">
                  <th className="px-3 py-2 text-left">GW</th>
                  <th className="px-3 py-2 text-left">Championship</th>
                  <th className="px-3 py-2 text-left">Challenger</th>
                  <th className="px-3 py-2 text-left">Wooden Spoon</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["GW31–33", "Playoff Groups — CA (1,4,5,8) & CB (2,3,6,7), single-leg round-robin", "Playoff Groups — XA (9,12,13,16) & XB (10,11,14,15), single-leg round-robin", "—"],
                  ["GW34", "Elite Seeding (top 2 of CA & CB)", "Challenger QFs (Champ 3rd/4th vs Chall 1st/2nd)", "WS Seeding (bottom 2 of XA & XB)"],
                  ["GW35–36", "Semi-Finals — #1 v #4, #2 v #3 (2-legged)", "Semi-Finals — QF winners (2-legged)", "Semi-Finals — #1 v #4, #2 v #3 (2-legged)"],
                  ["GW37–38", "Final + 3rd Place (2-legged)", "Final (5th) + 3rd (7th) (2-legged)", "Final (13th) + 3rd (15th) (2-legged)"],
                ].map(([gw, champ, chal, ws]) => (
                  <tr key={gw} className="border-b border-white/5">
                    <td className="px-3 py-2 text-yellow-400 font-mono text-xs whitespace-nowrap">{gw}</td>
                    <td className="px-3 py-2 text-green-300">{champ}</td>
                    <td className="px-3 py-2 text-yellow-300">{chal}</td>
                    <td className="px-3 py-2 text-red-300">{ws}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-4 space-y-2 text-gray-300 ml-2">
            <RuleItem accent="purple"><strong>Snake-seeded playoff groups:</strong> Each track is split into two sub-groups so the top of the track meets the bottom inside the same playoff group (e.g. Championship A = ranks 1, 4, 5, 8).</RuleItem>
            <RuleItem accent="purple"><strong>The Great Cut (GW34):</strong> Top 2 of each Championship group lock into the Championship SFs (via Elite Seeding). Bottom 2 of each Championship group drop down and play the top 2 of each Challenger group in the Challenger QFs. Bottom 2 of each Challenger group play the Wooden Spoon Seeding.</RuleItem>
            <RuleItem accent="purple"><strong>2-legged ties:</strong> Higher aggregate advances; on aggregate draw, higher Leg 2 score advances.</RuleItem>
            <RuleItem accent="purple"><strong>Playoffs captaincy:</strong> Unlimited — any player can captain any number of times.</RuleItem>
            <RuleItem accent="purple"><strong>Final placings:</strong> 1st–4th from Championship Final + 3rd; 5th–8th from Challenger Final + 3rd; 9th–12th decided by Challenger QFs (losers finish here); 13th–16th from Wooden Spoon Final + 3rd.</RuleItem>
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
