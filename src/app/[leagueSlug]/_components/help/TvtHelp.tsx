"use client";

import { useState } from "react";
import {
  AccordionItem,
  type ActiveTab,
  type FaqEntry,
  HelpTabBar,
  PublicSignInPrompt,
  ScenarioCard,
  type ScenarioEntry,
  SectionDivider,
  type UserRole,
} from "./shared";

interface Props {
  userRole: UserRole;
  teamSize: number;
  enabledChips: string[];
  leagueStageEnd: number;
}

export function TvtHelp({ userRole, teamSize, enabledChips, leagueStageEnd }: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("faqs");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const playoffStartGw = leagueStageEnd + 1;
  const midpoint = Math.ceil(leagueStageEnd / 2);
  const set1Label = `GW1 – GW${midpoint}`;
  const set2Label = `GW${midpoint + 1} – GW${leagueStageEnd}`;
  const topCutoff = teamSize === 8 ? 4 : 8;
  const eliminatedRange = teamSize === 8 ? "5–8" : teamSize === 16 ? "QF losers (4 teams, after GW34)" : "15–16";
  const variantLabel = teamSize === 8 ? "8-Team" : teamSize === 16 ? "16-Team" : "32-Team";
  const playoffBracketDesc =
    teamSize === 8
      ? `GW36: Semi-Finals (1v4, 2v3, single-leg). GW37–38: Final + 3rd Place (2-legged aggregate). Ranks 5–8 are eliminated after the league stage.`
      : teamSize === 16
      ? `JPL-TVT Merged Funnel — All 16 teams play GW31–38. GW31–33: Playoff Groups (Championship: ranks 1, 4, 5, 8 / 2, 3, 6, 7; Challenger: ranks 9, 12, 13, 16 / 10, 11, 14, 15). GW34–35: Championship Semi-Finals (2-legged aggregate, positionally seeded from group standings). GW34: Challenger QFs (Champ 3rd/4th vs Chall 1st/2nd) + Wooden Spoon Seeding (bottom 4 of Chall groups). GW35–36: Challenger and Wooden Spoon SFs (2-legged). GW36–38: Championship Final + 3rd Place (triple-legged aggregate). GW37–38: Challenger and Wooden Spoon Finals + 3rd Place (2-legged). Final placings: 1st–4th from Championship, 5th–8th from Challenger, 9th–12th from Challenger QF (losers), 13th–16th from Wooden Spoon.`
      : `GW31: RO16 Leg 1 + C-31 (Round of 12 KO, ranks 9–14 cross-group). GW32: RO16 Leg 2 + C-32 (Round of 6 KO). GW33: QF Leg 1 + Challenger Survival (RO16 losers + C-32 winners ranked by FPL points; top 8 advance). GW34: QF Leg 2 + C-34 (Survival top-8 KO). GW35: SF Leg 1 + C-35 (QF losers vs C-34 winners). GW36: SF Leg 2 + C-36. GW37: Final Leg 1 + C-37. GW38: Final Leg 2 + C-38 Challenger Final. Ranks 15–16 per group are eliminated after the league stage.`;

  const generalFaqs: FaqEntry[] = [
    {
      question: "What is JPL / TVT format?",
      answer: (
        <p>
          JPL (JPL Leagues) is a head-to-head FPL league format called <strong className="text-white">TVT (Two Vs Two)</strong>. Each team consists of two FPL managers. Every gameweek, teams compete head-to-head — the combined FPL score of both players determines the winner. The captain system, chip strategy, and playoff bracket make it far more competitive and interactive than standard FPL mini-leagues.
        </p>
      ),
    },
    {
      question: "How do I view standings, fixtures, and results?",
      answer: (
        <p>
          Use the navigation bar at the top of the page. <strong className="text-white">Standings</strong> shows the full league table with all teams ranked by points. <strong className="text-white">Fixtures</strong> shows all scheduled and completed matches — past gameweeks show final scores, future gameweeks show upcoming opponents. <strong className="text-white">Playoffs</strong> shows the knockout bracket once the playoff stage begins. All pages are publicly accessible — no login required.
        </p>
      ),
    },
    {
      question: "What do the colour bands on the standings table mean?",
      answer: (
        <div className="space-y-2">
          <p>The colour bands show each team&apos;s current playoff trajectory based on their league position:</p>
          <ul className="mt-2 space-y-1.5">
            <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-green-500 shrink-0" /><span><strong className="text-green-400">Green (Rank 1–{topCutoff}):</strong> On track for the Title Play-offs.</span></li>
            {teamSize === 32 && (
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-yellow-500 shrink-0" /><span><strong className="text-yellow-400">Yellow (Rank 9–14):</strong> On track for the Challenger Series.</span></li>
            )}
            {teamSize === 16 && (
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-yellow-500 shrink-0" /><span><strong className="text-yellow-400">Yellow (Rank 9–16):</strong> On track for the Challenger bracket (all 16 teams enter the playoffs).</span></li>
            )}
            {teamSize === 32 && (
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-red-500 shrink-0" /><span><strong className="text-red-400">Red (Rank {eliminatedRange}):</strong> Eliminated — no further play after the league stage.</span></li>
            )}
            {teamSize === 8 && (
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-red-500 shrink-0" /><span><strong className="text-red-400">Red (Rank {eliminatedRange}):</strong> Eliminated — no further play after the league stage.</span></li>
            )}
            {teamSize === 16 && (
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-red-500 shrink-0" /><span><strong className="text-red-400">No eliminations in the league stage:</strong> all 16 teams continue into the playoffs (Championship/Challenger/Wooden Spoon brackets). Final placings 9th–12th are decided by the Challenger QF losers in GW34.</span></li>
            )}
          </ul>
          <p className="text-xs text-gray-400 mt-2">These are live projections based on current standings. Final positions are determined after GW{leagueStageEnd}.</p>
        </div>
      ),
    },
    {
      question: "What is the league stage vs. the playoff stage?",
      answer: (
        <div className="space-y-2">
          <p><strong className="text-white">League Stage (GW1 – GW{leagueStageEnd}):</strong> Every team in {teamSize === 32 ? "their group" : "the league"} plays every other team twice (home and away). Points accumulated over these {leagueStageEnd} gameweeks determine the final standings and playoff seedings.</p>
          <p><strong className="text-white">Playoff Stage (GW{playoffStartGw} onwards):</strong> The top teams from the league stage advance into knockout rounds. Each tie is typically played over two legs (home &amp; away), with aggregate FPL score deciding the winner. The playoff format depends on your league variant ({variantLabel}).</p>
        </div>
      ),
    },
    {
      question: `What is the playoff bracket for this ${variantLabel} league?`,
      answer: (
        <div className="space-y-3">
          <p className="font-medium text-white">{variantLabel} Playoff Structure:</p>
          <p>{playoffBracketDesc}</p>
          <p className="text-xs text-gray-400">In 2-legged ties, the higher-seeded team plays at home in the first leg. Aggregate FPL score across both legs determines the winner. If aggregate is level, away goals or a replay GW may apply — check the Rules page for full details.</p>
        </div>
      ),
    },
    {
      question: "How can I join a league?",
      answer: (
        <p>
          Contact your league administrator. They will create a team account for you and share your login credentials (a team login ID and a temporary password). Once you receive them, click <strong className="text-white">Sign In</strong> in the navigation bar and log in. You will be prompted to set a new password on your first login. After that you will have full access to your team dashboard and can view all league pages.
        </p>
      ),
    },
  ];

  const teamFaqs: FaqEntry[] = [
    {
      question: "How do I log in for the first time?",
      answer: (
        <ol className="list-decimal list-inside space-y-1.5">
          <li>Click <strong className="text-white">Sign In</strong> in the navigation bar.</li>
          <li>Enter the <strong className="text-white">team login ID</strong> and <strong className="text-white">temporary password</strong> provided by your admin.</li>
          <li>You will be automatically redirected to the <strong className="text-white">Change Password</strong> page.</li>
          <li>Set your own secure password and confirm it.</li>
          <li>You will be logged in and taken to your team dashboard.</li>
        </ol>
      ),
    },
    {
      question: "How do I read my dashboard?",
      answer: (
        <div className="space-y-2">
          <p>Your dashboard is your personal command centre. It shows:</p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li><strong className="text-white">Current GW result</strong> — Win, Draw, or Loss, with your score vs opponent&apos;s score.</li>
            <li><strong className="text-white">Captain</strong> — which player was nominated and their doubled score.</li>
            <li><strong className="text-white">League position</strong> — your current rank, zone (Playoffs / Challenger / Eliminated), and points to the team above.</li>
            <li><strong className="text-white">Chip status</strong> — which chips you&apos;ve used in Set 1 and Set 2, and what remains.</li>
            <li><strong className="text-white">Season stats</strong> — played, W/D/L, total points, bonus points, and current streak.</li>
            <li><strong className="text-white">Recent form</strong> — last 5 results at a glance.</li>
          </ul>
        </div>
      ),
    },
    {
      question: "How is my team score calculated each gameweek?",
      answer: (
        <div className="space-y-2">
          <p><strong className="text-white">Team Score = (Player 1 FPL score − hits) + (Captain&apos;s net score × 2)</strong></p>
          <p>The captain&apos;s net FPL score (their score minus their own transfer hits) is doubled. Transfer hits reduce the score before doubling.</p>
          <p className="text-xs text-gray-400 bg-white/5 rounded-lg p-3 mt-2">
            Example: Player 1 (captain) scores 48 FPL pts with a −4 hit. Player 2 scores 37 pts (no hits).<br />
            → Captain net = 48 − 4 = 44, doubled = 88.<br />
            → Team score = 88 + 37 = 125 pts.
          </p>
          <p>If your team score is higher than your opponent&apos;s, you win the match (2 league pts). A tie gives 1 pt each. A loss gives 0 pts.</p>
        </div>
      ),
    },
    {
      question: "What is a captain and how do I submit one?",
      answer: (
        <div className="space-y-2">
          <p>Each gameweek, you nominate one of your two players as <strong className="text-white">captain</strong>. Their net FPL score (score minus hits) is doubled when calculating your team score.</p>
          <p><strong className="text-white">How to submit:</strong> Open your team dashboard, choose your captain in the <em>Captain</em> section, and click <strong className="text-white">Announce Captain</strong> (or <strong className="text-white">Switch Captain</strong> if you&apos;re changing your pick). Submit before the official FPL deadline — selections lock the moment the deadline passes.</p>
          <p className="text-yellow-300 text-xs">If no captain is submitted before the deadline, the system auto-assigns the lower-scoring player as captain (a temporary &quot;TEMP CAP&quot; tag is shown until the GW closes; admins can override in exceptional cases).</p>
        </div>
      ),
    },
    {
      question: "What happens if I miss the captain deadline?",
      answer: (
        <p>
          If no captain is submitted before the deadline, the system auto-assigns the <strong className="text-white">lower-scoring player</strong> as captain for that gameweek — the worst possible outcome for your score. This cannot be reversed retroactively. Always set a phone reminder ahead of the FPL deadline and submit through your dashboard early.
        </p>
      ),
    },
    {
      question: "What is a chip? How many do I have?",
      answer: (
        <div className="space-y-2">
          <p>Chips are one-time-use power-ups that can boost your league points for a specific gameweek. Your league has <strong className="text-white">{enabledChips.length} chips enabled</strong>.</p>
          <p>The league stage is split into two chip sets:</p>
          <ul className="list-disc list-inside space-y-1 ml-1 text-sm">
            <li><strong className="text-white">Set 1:</strong> {set1Label}</li>
            <li><strong className="text-white">Set 2:</strong> {set2Label}</li>
          </ul>
          <p>You can use each chip <strong className="text-white">once per set</strong>. Chips cannot be used in the playoff stage (GW{playoffStartGw}+).</p>
        </div>
      ),
    },
    {
      question: "What chips are enabled for this league?",
      answer: (
        <div className="space-y-3">
          {enabledChips.includes("W") && (
            <div className="rounded-lg bg-white/5 p-3">
              <p className="font-semibold text-green-400 mb-1">Win-Win (W) — +2 league points, guaranteed</p>
              <p className="text-sm">Earn +2 league points regardless of your match result. If you have net-negative transfer hits that GW (e.g., a −4 hit overrides your score), the chip is wasted — it counts as used but scores 0 points. Best played when you need a safe, guaranteed return.</p>
            </div>
          )}
          {enabledChips.includes("D") && (
            <div className="rounded-lg bg-white/5 p-3">
              <p className="font-semibold text-purple-400 mb-1">Double Pointer (D) — Double your match points</p>
              <p className="text-sm">Doubles your TVT match points for that GW: Win = +4 pts, Draw = +2 pts, Loss = 0 pts. Best played in a week you are confident of winning. Note: you must not be ranked in the top 2 of your group to use this chip.</p>
            </div>
          )}
          {enabledChips.includes("C") && teamSize === 32 && (
            <div className="rounded-lg bg-white/5 p-3">
              <p className="font-semibold text-orange-400 mb-1">Challenge Chip (C) — Challenge a top-2 team from the opposite group</p>
              <p className="text-sm">Creates an extra head-to-head fixture against one of the top 2 ranked teams from the opposite group. Win the challenge = +2 extra league points. No deduction for losing. Your regular fixture that GW also plays as normal.</p>
            </div>
          )}
          {enabledChips.includes("SL") && (
            <div className="rounded-lg bg-white/5 p-3">
              <p className="font-semibold text-blue-400 mb-1">Score Lock (SL) — Floor your score at your season average</p>
              <p className="text-sm">When you declare this chip, your season average (total FPL points ÷ GWs played so far) is recorded. If your actual GW score falls below that average, the average is used instead for the match calculation. Protects you from a disastrous gameweek.</p>
            </div>
          )}
          {enabledChips.includes("CB") && (
            <div className="rounded-lg bg-white/5 p-3">
              <p className="font-semibold text-yellow-400 mb-1">Comeback (CB) — +1 bonus point for bouncing back</p>
              <p className="text-sm">If you lost the previous gameweek AND win this gameweek, you earn +1 extra league point. Must be declared before the GW deadline. No benefit if you won or drew last week.</p>
            </div>
          )}
          {enabledChips.includes("UD") && (
            <div className="rounded-lg bg-white/5 p-3">
              <p className="font-semibold text-red-400 mb-1">Underdog (UD) — +1 bonus point for the upset</p>
              <p className="text-sm">If you are ranked 3 or more places below your opponent in the standings at processing time, and you win the match, you earn +1 extra league point. The rank snapshot is taken automatically at processing — you don&apos;t need to do anything extra.</p>
            </div>
          )}
        </div>
      ),
    },
    {
      question: "When can I use each chip? (Set 1 vs Set 2)",
      answer: (
        <div className="space-y-2">
          <p>Each chip can be used <strong className="text-white">once per chip set</strong> during the league stage:</p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li><strong className="text-white">Set 1:</strong> {set1Label} — one use of each chip.</li>
            <li><strong className="text-white">Set 2:</strong> {set2Label} — one use of each chip again.</li>
          </ul>
          <p>Activate your chip from your team dashboard&apos;s <em>Chips</em> section before the GW deadline. Once submitted and the deadline passes, the chip is locked — you cannot cancel or swap it. Captain selection is separate from chip activation; submit both before the deadline.</p>
          <p className="text-xs text-gray-400">Chips cannot be used in the playoff stage (GW{playoffStartGw}+).</p>
        </div>
      ),
    },
    {
      question: "What are bonus points?",
      answer: (
        <p>
          Bonus points are extra league points earned through chip effects. Examples: Win-Win gives +2 pts, Double Pointer doubles your match pts, Comeback gives +1 conditional pt, Underdog gives +1 conditional pt. These show in the <strong className="text-white">CP/BP</strong> column on the standings table. Bonus points can affect your final league position and tiebreakers.
        </p>
      ),
    },
    {
      question: "What are the tiebreaker rules?",
      answer: (
        <ol className="list-decimal list-inside space-y-1.5">
          <li><strong className="text-white">League points</strong> — higher total wins.</li>
          <li><strong className="text-white">Head-to-head record</strong> — points earned between the tied teams specifically.</li>
          <li><strong className="text-white">Total FPL score</strong> — combined FPL points across all gameweeks.</li>
          <li><strong className="text-white">Alphabetical order</strong> — last resort only.</li>
        </ol>
      ),
    },
    {
      question: "Can I see my season stats?",
      answer: (
        <p>
          Yes. Your team dashboard shows a complete season history: every gameweek&apos;s score, your opponent&apos;s score, the match result, captain used, chips played, and cumulative league points. You can scroll through all past GWs to review performance in detail.
        </p>
      ),
    },
  ];

  const publicScenarios: ScenarioEntry[] = [
    {
      number: 1,
      title: "Navigating the public pages",
      steps: [
        "Visit the home page and select your league from the league cards.",
        `Click "Standings" to see the full league table with colour-coded zones.`,
        `Click "Fixtures" to view all scheduled matches and past results.`,
        `Click "Playoffs" to see the knockout bracket (available once GW${playoffStartGw} begins).`,
        `Click "Rules" for the full scoring, chip, and playoff rules for this league.`,
        `Click "Help" (this page) any time you have questions.`,
      ],
    },
    {
      number: 2,
      title: "Reading the standings table (zones and tiebreakers)",
      steps: [
        "Each row represents one team. Columns show: Played (MP), Wins (W), Draws (D), Losses (L), Chips & Bonus Points (CP/BP), Total League Points (Pts), Total FPL Score (Scores).",
        `Green rows (Rank 1–${topCutoff}) are heading to the Title Play-offs.`,
        teamSize !== 8 ? "Yellow rows (Rank 9–14) are heading to the Challenger Series." : null,
        `Red rows (Rank ${eliminatedRange}) are eliminated after the league stage.`,
        "If two teams are tied on points, the tiebreaker order is: head-to-head record → total FPL score → alphabetical.",
      ].filter(Boolean) as string[],
    },
    {
      number: 3,
      title: `Reading the playoff bracket (${variantLabel})`,
      steps:
        teamSize === 8
          ? [
              `After GW35, the top 4 teams advance to the playoffs starting GW36.`,
              "GW36: Semi-Finals — 1st vs 4th (SF-A) and 2nd vs 3rd (SF-B), single-leg matches.",
              "GW37: SF losers play a 3rd Place match (single-leg). SF winners play Leg 1 of the Final.",
              "GW38: Final Leg 2. The team with the higher aggregate FPL score across both legs wins the title.",
              "Ranks 5–8 are eliminated after the league stage with no further matches.",
            ]
          : teamSize === 16
          ? [
              `After GW30, all 16 teams continue into a 3-bracket playoff (Championship, Challenger, Wooden Spoon). No one is eliminated yet.`,
              "GW31–33: Playoff Groups — 4 groups of 4, single-leg round-robin. Snake-seeded so top meets bottom inside each group.",
              "GW34 — The Great Cut: Championship SFs Leg 1 (positionally seeded — Group A 1st vs Group B 2nd, and mirror), Challenger QFs blend Champ 3rd/4th with Chall 1st/2nd, Wooden Spoon Seeding for bottom 4.",
              "GW34–35: Championship Semi-Finals (2-legged aggregate). GW35–36: Challenger and Wooden Spoon SFs (2-legged).",
              "GW36–38: Championship Final + 3rd Place — triple-legged aggregate across GW36/37/38. GW37–38: Challenger and Wooden Spoon Finals + 3rd Place (2-legged). Only the 4 Challenger QF losers have no further matches (they finish 9th–12th).",
            ]
          : [
              `After GW30, top 8 per group advance to the Title Play-offs; ranks 9–14 per group enter the Challenger Series; ranks 15–16 are eliminated.`,
              "GW31–32: Title — Round of 16 (cross-group, 2-legged: A1vB8 … A8vB1). Challenger — C-31 (Round of 12 KO) → C-32 (Round of 6).",
              "GW33: Title — QF Leg 1. Challenger — Survival GW: 8 RO16 losers + 3 C-32 winners ranked by FPL points; top 8 advance.",
              "GW34: Title — QF Leg 2. Challenger — C-34 (Survival top-8 KO).",
              "GW35–36: Title — Semi-Finals (2-legged). Challenger — C-35 (QF losers vs C-34 winners) → C-36.",
              "GW37–38: Title — Final (2-legged, leg 2 in GW38). Challenger — C-37 → C-38 Challenger Final (single-leg, GW38).",
              "In each 2-legged title tie, the higher seed plays at home in Leg 1. Aggregate FPL score decides the winner; on a draw, higher Leg 2 score advances.",
            ],
    },
    {
      number: 4,
      title: "Tracking finalists on the Hall of Champions",
      steps: [
        `Click "Winners" in the nav to view the Hall of Champions.`,
        "The table always shows every trophy position from season start onwards — Championship Bracket and (where applicable) Challenger Bracket sections.",
        "Rows are greyed out as 'TBD' until their underlying playoff round resolves — e.g. the Champion row fills after the Final completes; Challenger 3rd Place fills after that round resolves.",
        "Once every position is decided, the 'Tournament in Progress' banner at the top disappears.",
      ],
    },
  ];

  const teamScenarios: ScenarioEntry[] = userRole !== "public"
    ? [
        {
          number: 5,
          title: "Logging in for the first time and changing your password",
          steps: [
            `Click "Sign In" in the navigation bar.`,
            "Enter the team login ID and temporary password provided by your admin.",
            "You will be automatically redirected to the Change Password page.",
            "Enter your new password, confirm it, and submit.",
            "You are now logged in and will be taken to your team dashboard.",
          ],
        },
        {
          number: 6,
          title: "Submitting your captain before the deadline",
          steps: [
            "Decide which of your two players to nominate as captain for the upcoming GW.",
            "Check the FPL deadline time (shown on the FPL website, app, or your dashboard).",
            "Open your team dashboard and find the Captain section.",
            "Select the player you want as captain and click Announce Captain (or Switch Captain to change your pick) before the deadline.",
            "After the GW is processed, your dashboard will show which player was captain and their doubled score.",
          ],
        },
        {
          number: 7,
          title: "Using a chip for the first time",
          steps: [
            "Confirm the chip is available — check your dashboard to see which chips remain in the current set.",
            "Decide which chip to use and the gameweek you want to play it.",
            "From your dashboard's Chips section, select the chip and submit it before the GW deadline.",
            "Once the deadline passes, the chip is locked for that GW.",
            "After GW processing, your dashboard will show the chip outcome and any bonus points earned.",
          ],
        },
        {
          number: 8,
          title: "Understanding your dashboard after a result",
          steps: [
            "After the GW is processed, your dashboard updates with the final result.",
            "You will see your combined FPL score, your captain's doubled contribution, and any chip bonus applied.",
            "Your opponent's score is shown alongside — this determines the match result (Win/Draw/Loss).",
            "The standings table updates your rank and points automatically.",
            "If a chip was wasted (e.g., Win-Win played with net-negative hits), the dashboard shows 0 chip points.",
          ],
        },
        {
          number: 9,
          title: "Checking which chips you've used",
          steps: [
            "Log in and navigate to your team dashboard.",
            "Find the Chips section — it lists each enabled chip for Set 1 and Set 2.",
            "Used chips show the GW they were played and the points earned (or 'Wasted' if conditions weren't met).",
            "Available chips are shown as active — you can use any remaining chip before the current set ends.",
            `Set 1 ends after GW${midpoint}; Set 2 ends after GW${leagueStageEnd}. Unused chips do not carry over.`,
          ],
        },
      ]
    : [];

  const onTabChange = (t: ActiveTab) => { setActiveTab(t); setOpenIndex(null); };

  return (
    <>
      <HelpTabBar activeTab={activeTab} onChange={onTabChange} />

      {activeTab === "faqs" && (
        <div className="space-y-6">
          <div>
            <SectionDivider title="General" color="yellow" />
            <div className="space-y-2">
              {generalFaqs.map((faq, i) => (
                <AccordionItem key={i} index={i} question={faq.question} answer={faq.answer} openIndex={openIndex} setOpenIndex={setOpenIndex} />
              ))}
            </div>
          </div>

          {userRole !== "public" && (
            <div>
              <SectionDivider title="Team Members" color="purple" />
              <div className="space-y-2">
                {teamFaqs.map((faq, i) => (
                  <AccordionItem
                    key={generalFaqs.length + i}
                    index={generalFaqs.length + i}
                    question={faq.question}
                    answer={faq.answer}
                    openIndex={openIndex}
                    setOpenIndex={setOpenIndex}
                  />
                ))}
              </div>
            </div>
          )}

          {userRole === "public" && (
            <PublicSignInPrompt message="Sign in to see team-specific FAQs about captains, chips, scoring, and your dashboard." />
          )}
        </div>
      )}

      {activeTab === "scenarios" && (
        <div className="space-y-6">
          <div>
            <SectionDivider title="General" color="yellow" />
            <div className="space-y-4">
              {publicScenarios.map((s) => (
                <ScenarioCard key={s.number} number={s.number} title={s.title} steps={s.steps} />
              ))}
            </div>
          </div>

          {userRole !== "public" && (
            <div>
              <SectionDivider title="Team Members" color="purple" />
              <div className="space-y-4">
                {teamScenarios.map((s) => (
                  <ScenarioCard key={s.number} number={s.number} title={s.title} steps={s.steps} />
                ))}
              </div>
            </div>
          )}

          {userRole === "public" && (
            <PublicSignInPrompt message="Sign in to see step-by-step scenarios for captains, chips, and using your dashboard." />
          )}
        </div>
      )}
    </>
  );
}
