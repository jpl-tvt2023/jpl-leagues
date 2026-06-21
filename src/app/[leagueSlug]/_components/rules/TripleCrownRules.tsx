"use client";

import { RuleItem, SectionHeader } from "./shared";

export function TripleCrownRules() {
  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="A" color="purple" title="League Structure" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Format:</strong> 20 teams compete across 3 parallel competitions — JPL, JPL Cup Groups, and JCL/JEL Knockouts.</RuleItem>
          <RuleItem><strong>Squad:</strong> 2 FPL managers per team. Team score = combined FPL scores of both players minus transfer hits.</RuleItem>
          <RuleItem><strong>Captaincy:</strong> One player is nominated as captain per GW. Their net score (FPL score minus hits) is <strong>doubled</strong>. Same deadline and rules as TVT.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="orange" title="JPL" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Duration:</strong> All 38 gameweeks. Every team plays every other team twice (home &amp; away) — 38 matches total.</RuleItem>
          <RuleItem><strong>Match Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Scoring:</strong> Combined FPL score of both players minus transfer hits. Captain&apos;s net score is doubled.</RuleItem>
          <RuleItem><strong>Standings:</strong> Teams are ranked by total league points. JPL standings after GW5 determine cup group seeding.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="C" color="green" title="JPL Cup Groups" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Seeding:</strong> After GW5, the 20 teams are snake-seeded into 4 cup groups (A/B/C/D) of 5 teams each, based on JPL standings. Rank 1 gets the easiest group.</RuleItem>
          <RuleItem><strong>Ghost Teams:</strong> Each group has a 6th &quot;Ghost&quot; team. One team plays the Ghost each matchday. The Ghost&apos;s score = average of the other 4 human teams in the group (rounded up).</RuleItem>
          <RuleItem><strong>Schedule:</strong> 10 matchdays on even GWs: 6, 8, 10, 12, 14, 16, 18, 20, 22, 24. Each team plays every group opponent twice (including the Ghost).</RuleItem>
          <RuleItem><strong>Cup Points:</strong> Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</RuleItem>
          <RuleItem><strong>Qualification:</strong> Top 2 from each group qualify for JCL. Ranks 3–4 qualify for JEL.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="D" color="blue" title="JCL / JEL Knockouts" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>JCL (JPL Champions League):</strong> 8 teams (top 2 from each cup group). QF (GW27+29) → SF (GW33+35) → Final (GW37+38).</RuleItem>
          <RuleItem><strong>JEL (JPL Europa League):</strong> 8 teams (ranks 3–4 from each cup group). QF (GW27+29) → SF (GW33+35) → Final (GW37+38).</RuleItem>
          <RuleItem><strong>Format:</strong> Every round (QF / SF / Final) is 2-legged. Aggregate score across both legs decides the winner; on aggregate draw, the higher-seeded home team advances.</RuleItem>
          <RuleItem><strong>QF Seeding (cross-group):</strong></RuleItem>
          <li className="ml-8 space-y-1 text-sm">
            <div className="text-blue-400 font-medium">JCL: A1 vs C2, A2 vs C1, B1 vs D2, B2 vs D1</div>
            <div className="text-orange-400 font-medium">JEL: A3 vs C4, A4 vs C3, B3 vs D4, B4 vs D3</div>
          </li>
          <RuleItem><strong>Scoring:</strong> Same as JPL — combined FPL score minus hits, captain doubled. Each leg is scored independently.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="E" color="yellow" title="Transfer Hits & Tiebreakers" />
        <ul className="space-y-4 text-gray-300">
          <RuleItem><strong>Transfer Hits:</strong> Each FPL transfer beyond the free allowance costs −4 points. These are deducted from the player&apos;s score before captain doubling.</RuleItem>
          <RuleItem><strong>JPL Tiebreaker:</strong> Total FPL score (higher is better), then head-to-head record.</RuleItem>
          <RuleItem><strong>Cup Group Tiebreaker:</strong> Goal difference (total points scored for minus against), then total points scored.</RuleItem>
          <RuleItem><strong>Knockout Tiebreaker:</strong> If aggregate is tied after 2 legs, the team with the higher single-leg score wins. If still tied, the higher-seeded team advances.</RuleItem>
        </ul>
      </section>
    </div>
  );
}
