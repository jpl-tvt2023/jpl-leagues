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

export function TripleCrownHelp({ userRole }: { userRole: UserRole }) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("faqs");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const generalFaqs: FaqEntry[] = [
    {
      question: "What is Triple Crown format?",
      answer: (
        <p>
          Triple Crown is a 20-team JPL format with <strong className="text-white">three parallel competitions</strong>: Premier League (38-GW H2H round-robin), Cup Groups (UEFA-style group stage on even GWs 6–24), and UCL/UEL Knockouts (bracket stage after groups). Each team consists of two FPL managers. There are <strong className="text-white">no chips</strong> in this format, but the captain system is active.
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
      question: "How does the PL (Premier League) competition work?",
      answer: (
        <p>
          All 20 teams play each other twice across 38 gameweeks (home &amp; away). <strong className="text-white">Win = 2 pts, Draw = 1 pt, Loss = 0 pts.</strong> PL standings after GW5 determine cup group seeding — the higher you finish, the easier your cup group.
        </p>
      ),
    },
    {
      question: "What are Cup Groups?",
      answer: (
        <div className="space-y-2">
          <p>After GW5, teams are <strong className="text-white">snake-seeded</strong> into 4 cup groups (A/B/C/D) of 5 human teams each, based on PL standings. Rank 1 gets the easiest group.</p>
          <p>Cup matches are played on <strong className="text-white">10 even GWs</strong> (6, 8, 10, 12, 14, 16, 18, 20, 22, 24). Each matchday, 4 teams play human-vs-human and 1 team plays the Ghost.</p>
          <p>Cup group table uses football-style points: <strong className="text-white">Win = 3 pts, Draw = 1 pt, Loss = 0 pts.</strong></p>
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
      question: "How do UCL / UEL qualifications work?",
      answer: (
        <div className="space-y-2">
          <p>After all 10 cup group matchdays (GW24):</p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li><strong className="text-blue-400">UCL (Champions League):</strong> Top 2 from each cup group — 8 teams total.</li>
            <li><strong className="text-orange-400">UEL (Europa League):</strong> Ranks 3–4 from each cup group — 8 teams total.</li>
          </ul>
          <p className="text-xs text-gray-400">The 5th-placed team in each group (rank 5) does not qualify for knockouts.</p>
        </div>
      ),
    },
    {
      question: "What is the UCL/UEL knockout format?",
      answer: (
        <div className="space-y-2">
          <p>Both UCL and UEL follow the same structure: <strong className="text-white">Quarter-Finals → Semi-Finals → Final</strong>. All ties are 2-legged (aggregate score decides).</p>
          <p><strong className="text-white">QF seeding</strong> is cross-group:</p>
          <ul className="list-disc list-inside space-y-1 ml-1 text-sm">
            <li className="text-blue-400">UCL: A1 vs C2, A2 vs C1, B1 vs D2, B2 vs D1</li>
            <li className="text-orange-400">UEL: A3 vs C4, A4 vs C3, B3 vs D4, B4 vs D3</li>
          </ul>
        </div>
      ),
    },
    {
      question: "Are there chips in Triple Crown?",
      answer: (
        <p><strong className="text-white">No.</strong> Triple Crown does not use any special chips (Win-Win, Double Pointer, Challenge, etc.). The only power mechanic is the captain doubling system, which is active every GW.</p>
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
          <p>Announce your captain in the WhatsApp group <strong className="text-white">before the FPL deadline</strong>. The captain&apos;s net score is doubled for all three competitions that GW.</p>
          <p className="text-yellow-300 text-xs">Late or missing submissions: the lowest-scoring player is auto-assigned as captain (penalty).</p>
        </div>
      ),
    },
  ];

  const publicScenarios: ScenarioEntry[] = [
    {
      number: 1,
      title: "Navigating a Triple Crown league",
      steps: [
        "Visit the home page and select your league.",
        `"PL Standings" shows the 38-GW round-robin table.`,
        `"PL Fixtures" shows all PL H2H matches by gameweek.`,
        `"UEFA Standings" shows the 4 cup group tables.`,
        `"UEFA Fixtures" shows cup group matches (even GWs 6–24), including Ghost fixtures.`,
        `"Playoffs" shows the UCL and UEL knockout brackets.`,
      ],
    },
    {
      number: 2,
      title: "Reading a cup group table",
      steps: [
        "Each cup group has 5 human teams + 1 Ghost team.",
        "Teams are ranked by cup points (W=3, D=1, L=0), then goal difference (points scored).",
        "Green rows = top 2 (UCL qualification). Below that = ranks 3-4 (UEL). Rank 5 = no knockout.",
        "Ghost fixtures are shown in purple — the Ghost's score is the group average.",
      ],
    },
    {
      number: 3,
      title: "Understanding UCL/UEL bracket progress",
      steps: [
        `Navigate to "Playoffs" and switch between the UCL and UEL tabs.`,
        "Each tie shows both legs with individual and aggregate scores.",
        "Click/expand any tie to see the player breakdown for each leg.",
        "Winners advance to the next round until the Final determines the champion.",
      ],
    },
  ];

  const teamScenarios: ScenarioEntry[] = userRole !== "public"
    ? [
        {
          number: 4,
          title: "Submitting your captain in Triple Crown",
          steps: [
            "Decide which player to nominate as captain for the upcoming GW.",
            `Post in the WhatsApp group before the deadline — e.g., "GW12 Captain: Rahul".`,
            "The same captain applies to PL, Cup Group, and any Knockout match that GW.",
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
