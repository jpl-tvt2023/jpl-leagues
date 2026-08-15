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

export function ContinentalChampionshipHelp({ userRole }: { userRole: UserRole }) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("faqs");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const generalFaqs: FaqEntry[] = [
    {
      question: "What is JPL Continental Championship format?",
      answer: (
        <p>
          JPL Continental Championship is a 20-team format with <strong className="text-white">three parallel competitions</strong>: JPL (38-GW H2H round-robin), JPL Cup Groups (group stage on even GWs 6–24), and JCL/JEL Knockouts (bracket stage after groups). Each team consists of two FPL managers. The captain system is active every gameweek.
        </p>
      ),
    },
    {
      question: "How is my team score calculated?",
      answer: (
        <div className="space-y-2">
          <p><strong className="text-white">Team Score = (Non-Captain FPL score − hits) + (Captain net score × 2)</strong></p>
          <p>One player is nominated as captain each GW. Their net FPL score (score minus transfer hits) is doubled. The same score is used across all three competitions that GW.</p>
        </div>
      ),
    },
    {
      question: "How does the JPL competition work?",
      answer: (
        <p>
          All 20 teams play each other twice across 38 gameweeks (home &amp; away). <strong className="text-white">Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</strong> JPL standings after GW5 determine cup group seeding — the higher you finish, the easier your cup group.
        </p>
      ),
    },
    {
      question: "What are Cup Groups?",
      answer: (
        <div className="space-y-2">
          <p>After GW5, teams are <strong className="text-white">snake-seeded</strong> into 4 cup groups (A/B/C/D) of 5 human teams each, based on JPL standings. Rank 1 gets the easiest group.</p>
          <p>Cup matches are played on <strong className="text-white">10 even GWs</strong> (6, 8, 10, 12, 14, 16, 18, 20, 22, 24). Each matchday, 4 teams play human-vs-human and 1 team plays the Ghost.</p>
          <p>Cup group table points: <strong className="text-white">Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</strong></p>
        </div>
      ),
    },
    {
      question: "What is the Ghost team? How is it scored?",
      answer: (
        <div className="space-y-2">
          <p>Each cup group has a 6th <strong className="text-purple-400">Ghost</strong> team. One human team plays the Ghost each matchday (rotating).</p>
          <p>The Ghost&apos;s score = <strong className="text-white">average of the other 4 human teams&apos; scores in the group</strong> that GW (rounded up). It&apos;s a fair benchmark — you&apos;re playing against the group average.</p>
        </div>
      ),
    },
    {
      question: "How do JCL / JEL qualifications work?",
      answer: (
        <div className="space-y-2">
          <p>After all 10 cup group matchdays (GW24):</p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li><strong className="text-blue-400">JCL (JPL Champions League):</strong> Top 2 from each cup group — 8 teams total.</li>
            <li><strong className="text-orange-400">JEL (JPL Europa League):</strong> Ranks 3–4 from each cup group — 8 teams total.</li>
          </ul>
          <p className="text-xs text-gray-400">The 5th-placed team in each group (rank 5) does not qualify for knockouts.</p>
        </div>
      ),
    },
    {
      question: "What is the JCL/JEL knockout format?",
      answer: (
        <div className="space-y-2">
          <p>Both JCL and JEL follow the same structure: <strong className="text-white">Quarter-Finals → Semi-Finals → Final</strong>. All ties are 2-legged (aggregate score decides).</p>
          <p><strong className="text-white">QF seeding</strong> is cross-group:</p>
          <ul className="list-disc list-inside space-y-1 ml-1 text-sm">
            <li className="text-blue-400">JCL: A1 vs C2, A2 vs C1, B1 vs D2, B2 vs D1</li>
            <li className="text-orange-400">JEL: A3 vs C4, A4 vs C3, B3 vs D4, B4 vs D3</li>
          </ul>
        </div>
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
          <li>You will be redirected to set a new password.</li>
          <li>After that you have full access to your team dashboard.</li>
        </ol>
      ),
    },
    {
      question: "How do I submit my captain?",
      answer: (
        <div className="space-y-2">
          <p>Open your team dashboard, choose your captain in the <em>Captain</em> section, and click <strong className="text-white">Announce Captain</strong> (or <strong className="text-white">Switch Captain</strong> if you&apos;re changing your pick) <strong className="text-white">before the FPL deadline</strong>. The captain&apos;s net score is doubled for all three competitions that GW. Selections lock the moment the deadline passes.</p>
          <p className="text-yellow-300 text-xs">Late or missing submissions: the lower-scoring player is auto-assigned as captain (penalty).</p>
        </div>
      ),
    },
  ];

  const publicScenarios: ScenarioEntry[] = [
    {
      number: 1,
      title: "Navigating a JPL Continental Championship league",
      steps: [
        "Visit the home page and select your league.",
        `"JPL Standings" shows the 38-GW round-robin table.`,
        `"JPL Fixtures" shows all JPL H2H matches by gameweek.`,
        `"JPL Cup Standings" shows the 4 cup group tables.`,
        `"JPL Cup Fixtures" shows cup group matches (even GWs 6–24), including Ghost fixtures.`,
        `"Playoffs" shows the JCL and JEL knockout brackets.`,
      ],
    },
    {
      number: 2,
      title: "Reading a cup group table",
      steps: [
        "Each cup group has 5 human teams + 1 Ghost team.",
        "Teams are ranked by cup points (W=2, D=1, L=0), then goal difference (points scored).",
        "Green rows = top 2 (JCL qualification). Below that = ranks 3-4 (JEL). Rank 5 = no knockout.",
        "Ghost fixtures are shown in purple — the Ghost's score is the group average.",
      ],
    },
    {
      number: 3,
      title: "Understanding JCL/JEL bracket progress",
      steps: [
        `Navigate to "Playoffs" and switch between the JCL and JEL tabs.`,
        "Each tie shows both legs with individual and aggregate scores.",
        "Click/expand any tie to see the player breakdown for each leg.",
        "Winners advance to the next round until the Final determines the champion.",
      ],
    },
    {
      number: 4,
      title: "Tracking champions on the Hall of Champions",
      steps: [
        `Click "Winners" in the nav to view the Hall of Champions.`,
        "Three trophy cards are shown: JPL Champion, JCL Champion, JEL Champion — each with its own colour identity.",
        "Each card stays as a greyed 'TBD' placeholder until its competition concludes: JCL and JEL after their Finals (GW38), JPL Champion after the league standings settle.",
        "The 'Tournament in Progress' banner at the top clears once all three are decided.",
      ],
    },
  ];

  const teamScenarios: ScenarioEntry[] = userRole !== "public"
    ? [
        {
          number: 5,
          title: "Submitting your captain in JPL Continental Championship",
          steps: [
            "Decide which player to nominate as captain for the upcoming GW.",
            "Open your dashboard's *Captain* section, pick the player, and click **Announce Captain** before the FPL deadline.",
            "The same captain applies to JPL, JPL Cup Group, and any Knockout match that GW.",
            "After processing, your dashboard shows the captain's doubled contribution.",
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
            <PublicSignInPrompt message="Sign in to see team-specific FAQs about captains and scoring." />
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
            <PublicSignInPrompt message="Sign in to see step-by-step scenarios for captains and using your dashboard." />
          )}
        </div>
      )}
    </>
  );
}
