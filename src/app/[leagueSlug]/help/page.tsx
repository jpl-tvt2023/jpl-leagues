"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

type UserRole = "public" | "team" | "admin";
type ActiveTab = "faqs" | "scenarios";

interface AccordionItemProps {
  index: number;
  question: string;
  answer: React.ReactNode;
  openIndex: number | null;
  setOpenIndex: (i: number | null) => void;
}

function AccordionItem({ index, question, answer, openIndex, setOpenIndex }: AccordionItemProps) {
  const isOpen = openIndex === index;
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpenIndex(isOpen ? null : index)}
        className="w-full flex items-center justify-between px-5 py-4 text-left text-white font-medium hover:bg-white/5 transition"
      >
        <span>{question}</span>
        <span className="ml-4 text-gray-400 shrink-0 text-xs">{isOpen ? "▲" : "▼"}</span>
      </button>
      {isOpen && (
        <div className="px-5 pb-5 text-gray-300 text-sm leading-relaxed border-t border-white/10 pt-4">
          {answer}
        </div>
      )}
    </div>
  );
}

interface ScenarioCardProps {
  number: number;
  title: string;
  steps: string[];
}

function ScenarioCard({ number, title, steps }: ScenarioCardProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
      <h3 className="font-semibold text-white mb-3">
        <span className="text-yellow-400 mr-2">{number}.</span>
        {title}
      </h3>
      <ol className="list-decimal list-inside space-y-2 text-gray-300 text-sm">
        {steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

export default function LeagueHelpPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;

  const [userRole, setUserRole] = useState<UserRole>("public");
  const [teamSize, setTeamSize] = useState<number>(32);
  const [enabledChips, setEnabledChips] = useState<string[]>(["D", "W", "C"]);
  const [leagueStageEnd, setLeagueStageEnd] = useState<number>(30);
  const [leagueName, setLeagueName] = useState<string>("");
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("faqs");
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated && (d.type === "admin" || d.type === "superadmin")) {
          setUserRole("admin");
          setIsLoggedIn(true);
        } else if (d.authenticated && d.type === "team") {
          setUserRole("team");
          setIsLoggedIn(true);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/leagues")
      .then((r) => r.json())
      .then((data) => {
        const league = (data.leagues || []).find((l: { slug: string; name: string }) => l.slug === leagueSlug);
        if (league) setLeagueName(league.name);
      })
      .catch(() => {});
  }, [leagueSlug]);

  useEffect(() => {
    fetch(`/api/standings?leagueSlug=${encodeURIComponent(leagueSlug)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.teamSize) setTeamSize(data.teamSize);
        if (data.enabledChips) setEnabledChips(data.enabledChips);
        if (data.leagueStageEnd) setLeagueStageEnd(data.leagueStageEnd);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, [leagueSlug]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  // Derived values
  const playoffStartGw = leagueStageEnd + 1;
  const midpoint = Math.ceil(leagueStageEnd / 2);
  const set1Label = `GW1 – GW${midpoint}`;
  const set2Label = `GW${midpoint + 1} – GW${leagueStageEnd}`;
  const topCutoff = teamSize === 8 ? 4 : 8;
  const eliminatedRange = teamSize === 8 ? "5–8" : teamSize === 16 ? "QF losers (4 teams, after GW34)" : "15–16";
  const variantLabel = teamSize === 8 ? "8-Team" : teamSize === 16 ? "16-Team" : "32-Team";

  // Playoff bracket description per variant
  const playoffBracketDesc =
    teamSize === 8
      ? `GW36: Semi-Finals (1v4, 2v3, single-leg). GW37–38: Final + 3rd Place (2-legged aggregate). Ranks 5–8 are eliminated after the league stage.`
      : teamSize === 16
      ? `JPL-TVT Merged Funnel — All 16 teams play GW31–38. GW31–33: Group sprints (Championship ranks 1–8, Challenger ranks 9–16). GW34: Merger QFs (4 relegated Champs vs 4 surviving Challengers) + Elite Seeding (top 4) + Wooden Spoon Seeding (bottom 4). GW35–36: SFs across all 3 brackets. GW37–38: Finals + 3rd Place ties. Only the 4 Challenger QF losers (GW34) are eliminated.`
      : `GW31–32: Round of 16 (cross-group seeding, 2-legged). GW33–34: Quarter-Finals. GW35–36: Semi-Finals. GW37–38: Final. Ranks 9–14 per group enter the Challenger Series. Ranks 15–16 per group are eliminated.`;

  // --- FAQ CONTENT ---

  // Section 1: General (indices 0–5)
  const generalFaqs = [
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
              <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-red-500 shrink-0" /><span><strong className="text-red-400">Red ({eliminatedRange}):</strong> Eliminated after GW34 Challenger QFs — only these 4 teams are knocked out in the entire playoff series.</span></li>
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

  // Section 2: Team Users (indices 6–16)
  const teamFaqs = [
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
          <p><strong className="text-white">How to submit:</strong> Announce your captain&apos;s name in the designated WhatsApp group at least 1 second before the official FPL deadline. For a 4:30 PM deadline, that means by 4:29:59 PM at the latest.</p>
          <p className="text-yellow-300 text-xs">Late submissions are treated as invalid — your admin will assign the lower-scoring player as captain automatically.</p>
        </div>
      ),
    },
    {
      question: "What happens if I miss the captain deadline?",
      answer: (
        <p>
          If no valid captain announcement is made before the deadline, your admin will automatically assign the <strong className="text-white">lower-scoring player</strong> as captain for that gameweek — the worst possible outcome for your score. This cannot be reversed retroactively. Always set a phone reminder ahead of the FPL deadline.
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
          <p>Declare your chip in the WhatsApp group before the GW deadline — ideally in the same message as your captain announcement. Once used in a set, that chip is gone for that set. You cannot cancel or swap a chip after the deadline.</p>
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

  // All FAQs flat-indexed
  const allFaqs = [
    ...generalFaqs,
    ...(userRole !== "public" ? teamFaqs : []),
  ];

  // --- SCENARIO CONTENT ---

  const publicScenarios = [
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
        teamSize !== 8
          ? "Yellow rows (Rank 9–14) are heading to the Challenger Series."
          : "There is no Challenger Series in the 8-team format.",
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
              `After GW30, the top 8 teams advance and ranks 9–14 enter the Challenger Series.`,
              "GW31–32: Quarter-Finals (2-legged) — seeded 1v8, 2v7, 3v6, 4v5.",
              "GW33–34: Semi-Finals (2-legged) — QF winners advance.",
              "GW35–36: Final (2-legged) — SF winners compete for the title.",
              "In each 2-legged tie, the higher seed plays at home in the first leg. Aggregate score decides the winner.",
            ]
          : [
              `After GW30, top 8 per group advance to the Title Play-offs; ranks 9–14 enter the Challenger Series.`,
              "GW31–32: Round of 16 (cross-group seeding, 2-legged) — A1 vs B8, A2 vs B7, etc.",
              "GW33–34: Quarter-Finals (2-legged).",
              "GW35–36: Semi-Finals (2-legged).",
              "GW37–38: Final (2-legged).",
              "In each 2-legged tie, the higher seed plays at home in the first leg.",
            ],
    },
  ];

  const teamScenarios = userRole !== "public"
    ? [
        {
          number: 4,
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
          number: 5,
          title: "Submitting your captain before the deadline",
          steps: [
            "Decide which of your two players to nominate as captain for the upcoming GW.",
            "Check the FPL deadline time (shown on the FPL website or app).",
            `Post your announcement in the WhatsApp group at least 1 second before the deadline — e.g., "GW12 Captain: Rahul".`,
            "Your admin will record the captain selection.",
            "After the GW is processed, your dashboard will show which player was captain and their doubled score.",
          ],
        },
        {
          number: 6,
          title: "Using a chip for the first time",
          steps: [
            "Confirm the chip is available — check your dashboard to see which chips remain in the current set.",
            "Decide which chip to use and the gameweek you want to play it.",
            `Declare in the WhatsApp group before the GW deadline — e.g., "GW12 Chip: Win-Win". Include your captain announcement too.`,
            "Your admin registers the chip before processing.",
            "After GW processing, your dashboard will show the chip outcome and any bonus points earned.",
          ],
        },
        {
          number: 7,
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
          number: 8,
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

  const allScenarios = [...publicScenarios, ...teamScenarios];

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
          <Link href={isLoggedIn ? "/dashboard" : "/"} className="text-gray-300 hover:text-white transition">{isLoggedIn ? "Dashboard" : "All Leagues"}</Link>
          <Link href={`/${leagueSlug}/standings`} className="text-gray-300 hover:text-white transition">Standings</Link>
          <Link href={`/${leagueSlug}/fixtures`} className="text-gray-300 hover:text-white transition">Fixtures</Link>
          <Link href={`/${leagueSlug}/playoffs`} className="text-gray-300 hover:text-white transition">Playoffs</Link>
          <Link href={`/${leagueSlug}/winners`} className="text-gray-300 hover:text-white transition">Winners</Link>
          <Link href={`/${leagueSlug}/rules`} className="text-gray-300 hover:text-white transition">Rules</Link>
          <Link href={`/${leagueSlug}/help`} className="text-yellow-400 font-semibold transition">Help</Link>
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
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 rounded-full bg-yellow-400/10 border border-yellow-400/20 px-4 py-1.5 text-sm text-yellow-400 font-medium mb-4">
            {variantLabel} Format
          </div>
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-3">Help &amp; Guidance</h1>
          <p className="text-gray-400">
            {leagueName ? `${leagueName} · ` : ""}FAQs and step-by-step scenarios for this league
          </p>
          {userRole !== "public" && (
            <p className="text-xs text-purple-400 mt-2">
              {userRole === "team" ? "Showing team member content" : "Showing admin + team content"}
            </p>
          )}
        </div>

        {isLoading ? (
          <LoadingScreen variant="help" fullScreen={false} />
        ) : (
          <>
            {/* Tab Bar */}
            <div className="flex gap-2 mb-8">
              {(["faqs", "scenarios"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => { setActiveTab(tab); setOpenIndex(null); }}
                  className={`px-5 py-2.5 rounded-lg font-semibold text-sm transition ${
                    activeTab === tab
                      ? "bg-yellow-500 text-slate-900"
                      : "bg-white/5 text-gray-300 hover:bg-white/10"
                  }`}
                >
                  {tab === "faqs" ? "FAQs" : "Scenarios"}
                </button>
              ))}
            </div>

            {/* FAQs Tab */}
            {activeTab === "faqs" && (
              <div className="space-y-6">
                {/* Section 1 — General */}
                <div>
                  <h2 className="text-lg font-bold text-yellow-400 mb-3 flex items-center gap-2">
                    <span className="h-px flex-1 bg-yellow-400/20" />
                    General
                    <span className="h-px flex-1 bg-yellow-400/20" />
                  </h2>
                  <div className="space-y-2">
                    {generalFaqs.map((faq, i) => (
                      <AccordionItem
                        key={i}
                        index={i}
                        question={faq.question}
                        answer={faq.answer}
                        openIndex={openIndex}
                        setOpenIndex={setOpenIndex}
                      />
                    ))}
                  </div>
                </div>

                {/* Section 2 — Team Users */}
                {userRole !== "public" && (
                  <div>
                    <h2 className="text-lg font-bold text-purple-400 mb-3 flex items-center gap-2">
                      <span className="h-px flex-1 bg-purple-400/20" />
                      Team Members
                      <span className="h-px flex-1 bg-purple-400/20" />
                    </h2>
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
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
                    <p className="text-gray-400 text-sm">
                      <strong className="text-white">Team member?</strong> Sign in to see team-specific FAQs about captains, chips, scoring, and your dashboard.
                    </p>
                    <Link
                      href="/signin"
                      className="inline-block mt-3 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-2 font-semibold text-slate-900 text-sm hover:from-yellow-300 hover:to-orange-400 transition"
                    >
                      Sign In
                    </Link>
                  </div>
                )}
              </div>
            )}

            {/* Scenarios Tab */}
            {activeTab === "scenarios" && (
              <div className="space-y-6">
                {/* Public Scenarios */}
                <div>
                  <h2 className="text-lg font-bold text-yellow-400 mb-3 flex items-center gap-2">
                    <span className="h-px flex-1 bg-yellow-400/20" />
                    General
                    <span className="h-px flex-1 bg-yellow-400/20" />
                  </h2>
                  <div className="space-y-4">
                    {publicScenarios.map((s) => (
                      <ScenarioCard key={s.number} number={s.number} title={s.title} steps={s.steps} />
                    ))}
                  </div>
                </div>

                {/* Team Scenarios */}
                {userRole !== "public" && (
                  <div>
                    <h2 className="text-lg font-bold text-purple-400 mb-3 flex items-center gap-2">
                      <span className="h-px flex-1 bg-purple-400/20" />
                      Team Members
                      <span className="h-px flex-1 bg-purple-400/20" />
                    </h2>
                    <div className="space-y-4">
                      {teamScenarios.map((s) => (
                        <ScenarioCard key={s.number} number={s.number} title={s.title} steps={s.steps} />
                      ))}
                    </div>
                  </div>
                )}

                {userRole === "public" && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
                    <p className="text-gray-400 text-sm">
                      <strong className="text-white">Team member?</strong> Sign in to see step-by-step scenarios for captains, chips, and using your dashboard.
                    </p>
                    <Link
                      href="/signin"
                      className="inline-block mt-3 rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-2 font-semibold text-slate-900 text-sm hover:from-yellow-300 hover:to-orange-400 transition"
                    >
                      Sign In
                    </Link>
                  </div>
                )}
              </div>
            )}

            {/* Footer note */}
            <div className="mt-10 text-center text-sm text-gray-500">
              Still have questions? Contact your league admin or visit the{" "}
              <Link href={`/${leagueSlug}/rules`} className="text-yellow-400 hover:text-yellow-300 transition">
                Rules page
              </Link>{" "}
              for full technical details.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
