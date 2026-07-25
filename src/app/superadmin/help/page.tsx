"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { LoadingScreen } from "@/components/LoadingScreen";
import { Logo } from "@/components/Logo";

type TabType = "faqs" | "scenarios";

function AccordionItem({
  index,
  question,
  answer,
  openIndex,
  setOpenIndex,
}: {
  index: number;
  question: string;
  answer: React.ReactNode;
  openIndex: number | null;
  setOpenIndex: (i: number | null) => void;
}) {
  const isOpen = openIndex === index;
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpenIndex(isOpen ? null : index)}
        className="w-full flex items-center justify-between px-5 py-4 text-left text-white font-medium hover:bg-white/5 transition"
      >
        <span>{question}</span>
        <span className="ml-4 text-gray-400 shrink-0">{isOpen ? "▲" : "▼"}</span>
      </button>
      {isOpen && (
        <div className="px-5 pb-4 text-gray-300 text-sm leading-relaxed border-t border-white/10 pt-3">
          {answer}
        </div>
      )}
    </div>
  );
}

function ScenarioCard({ number, title, steps }: { number: number; title: string; steps: string[] }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
      <h3 className="font-semibold text-white mb-3">{number}. {title}</h3>
      <ol className="list-decimal list-inside space-y-2 text-gray-300 text-sm">
        {steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

export default function SuperadminHelpPage() {
  const [activeTab, setActiveTab] = useState<TabType>("faqs");
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/superadmin/leagues");
        if (res.status === 401 || res.status === 403) {
          window.location.href = "/signin";
          return;
        }
      } catch {
        window.location.href = "/signin";
        return;
      }
      setIsLoading(false);
    };
    checkAuth();
  }, []);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  if (isLoading) {
    return <LoadingScreen variant="help" />;
  }

  const faqs: { question: string; answer: React.ReactNode }[] = [
    {
      question: "How do I create a new league?",
      answer: (
        <div className="space-y-2">
          <p>Click <strong className="text-white">+ New League</strong> on the Superadmin dashboard. The wizard has 6 steps:</p>
          <ol className="list-decimal list-inside space-y-1 mt-2">
            <li><strong className="text-white">Sport</strong> — choose Football (FPL). Cricket is coming soon.</li>
            <li><strong className="text-white">Format</strong> — choose TVT (head-to-head with chips, captaincy, playoffs). Classic is coming soon.</li>
            <li><strong className="text-white">Team Size</strong> — 32, 16, or 8 teams. This determines group structure and playoff schedule.</li>
            <li><strong className="text-white">Chips</strong> — select which chips are enabled for this league (Win-Win, Double Pointer, Challenge Chip, Score Lock, Comeback, Underdog).</li>
            <li><strong className="text-white">Details</strong> — enter the league name, slug, season, and playoff start gameweek.</li>
            <li><strong className="text-white">Assign Admin</strong> — optionally assign an existing admin account to manage this league.</li>
          </ol>
        </div>
      ),
    },
    {
      question: "How should I name league slugs?",
      answer: (
        <div className="space-y-2">
          <p>Slugs are the URL identifier for each league (e.g., <code className="bg-white/10 px-1 rounded">jpl-2025</code> becomes <code className="bg-white/10 px-1 rounded">/jpl-2025/standings</code>).</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li>Use lowercase letters, numbers, and hyphens only.</li>
            <li>No spaces, underscores, or special characters.</li>
            <li>Keep it short and readable — e.g. <code className="bg-white/10 px-1 rounded">jpl-s1</code>, <code className="bg-white/10 px-1 rounded">premier-2025</code>.</li>
            <li>Slugs must be unique across all leagues. The system will warn you if a slug is already taken.</li>
            <li>Slugs cannot be changed after a league is created, so choose carefully.</li>
          </ul>
        </div>
      ),
    },
    {
      question: "Which chips should I enable for a league?",
      answer: (
        <div className="space-y-2">
          <p>You can enable any combination of the 6 available chips:</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li><strong className="text-white">Win-Win (WW)</strong> — rewards teams whose two FPL players both score positively in the same GW.</li>
            <li><strong className="text-white">Double Pointer (DP)</strong> — doubles a team&apos;s league points for a gameweek.</li>
            <li><strong className="text-white">Challenge Chip (CC)</strong> — replaces a team&apos;s fixture with a top-2 opponent from the <em>opposite group</em>. <span className="text-red-400 font-medium">Not available for 8-team or 16-team formats</span> — the wizard will disable it automatically when you select those sizes.</li>
            <li><strong className="text-white">Score Lock (SL)</strong> — floors a team&apos;s GW score at their season average.</li>
            <li><strong className="text-white">Comeback (CB)</strong> — rewards a win following a loss with +1 extra league point.</li>
            <li><strong className="text-white">Underdog (UD)</strong> — rewards a win against a 3+ higher-ranked opponent with +1 extra league point.</li>
          </ul>
          <p className="mt-2">For a 32-team TVT league, enabling all 6 is recommended. For 16-team or 8-team formats, choose any 3 from the remaining 5 (CC is unavailable).</p>
        </div>
      ),
    },
    {
      question: "What are the differences between the 32, 16, and 8-team formats?",
      answer: (
        <div className="space-y-2">
          <div>
            <p className="font-medium text-white">32-team:</p>
            <p>2 groups of 16. 30 GW league stage. Playoffs GW31–38 (RO16 → QF → SF → Final). Challenger bracket for ranks 9–14 per group. Ranks 15–16 eliminated.</p>
          </div>
          <div className="mt-2">
            <p className="font-medium text-white">16-team (JPL-TVT Merged Funnel):</p>
            <p>1 group of 16. 30 GW league stage. Playoffs GW31–38 across three brackets: Championship (top 8 from playoff group sprints), Challenger (mid 8 — Challenger QF losers eliminated), and Wooden Spoon (bottom 4). Group sprints GW31–33; Championship SFs GW34–35 (2-legged) + Challenger QFs / WS Seeding GW34; Challenger/WS SFs GW35–36; Championship Final + 3rd Place GW36–38 (triple-legged aggregate); Challenger/WS Finals + 3rd Place GW37–38 (2-legged). All 16 teams play until GW34; only the 4 Challenger QF losers are eliminated.</p>
          </div>
          <div className="mt-2">
            <p className="font-medium text-white">8-team:</p>
            <p>1 group of 8. 35 GW league stage (5× round-robin). Playoffs GW36–38 (SF → 3rd place + Final). No Challenger bracket. Ranks 5–8 are eliminated.</p>
          </div>
        </div>
      ),
    },
    {
      question: "How do I assign an admin to a league?",
      answer: (
        <div className="space-y-2">
          <p>You can assign an admin during league creation (Step 6 of the wizard) or afterwards from the Admins tab:</p>
          <ol className="list-decimal list-inside space-y-1 mt-2">
            <li>Go to the <strong className="text-white">Admins</strong> tab on the Superadmin dashboard.</li>
            <li>Find the admin account and click <strong className="text-white">Assign Leagues</strong>.</li>
            <li>Select the leagues to assign and save.</li>
          </ol>
          <p className="mt-2">An admin can manage multiple leagues. They will see all assigned leagues in their admin panel.</p>
        </div>
      ),
    },
    {
      question: "Can I edit a league after it has been created?",
      answer: (
        <div className="space-y-2">
          <p>Currently, league editing post-creation is limited. The league name, season, active status, and chip configuration can be updated. The league slug, team size, and group count cannot be changed after creation.</p>
          <p className="mt-2">If you need to change structural settings (team size, group count, slug), you should delete the league and recreate it — but only do this before any teams are added.</p>
        </div>
      ),
    },
    {
      question: "What happens when I delete a league?",
      answer: (
        <div className="space-y-2">
          <p className="text-red-400 font-medium">Warning: Deleting a league is permanent and cascades to all related data.</p>
          <p>This will delete:</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li>All teams registered in the league</li>
            <li>All fixtures and gameweek results</li>
            <li>All chip records and captain submissions</li>
            <li>All playoff bracket data</li>
          </ul>
          <p className="mt-2">There is no undo. Only delete a league if you are certain no data needs to be preserved.</p>
        </div>
      ),
    },
    {
      question: "How do I create an admin account?",
      answer: (
        <div className="space-y-2">
          <p>Go to the <strong className="text-white">Admins</strong> tab on the Superadmin dashboard and click <strong className="text-white">+ New Admin</strong>.</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li>Enter the admin&apos;s name and email address.</li>
            <li>A temporary password will be generated. Share it with the admin securely.</li>
            <li>The admin will be prompted to change their password on first login.</li>
          </ul>
          <p className="mt-2">Admin accounts can be assigned to multiple leagues at any time.</p>
        </div>
      ),
    },
    {
      question: "Can one admin manage multiple leagues?",
      answer: (
        <p>Yes. An admin can be assigned to any number of leagues. When they log in, they see all leagues assigned to them and can switch between them. Assign additional leagues from the Admins tab by clicking <strong className="text-white">Assign Leagues</strong> on the admin&apos;s row.</p>
      ),
    },
    {
      question: "How do I set the playoff start gameweek?",
      answer: (
        <div className="space-y-2">
          <p>The playoff start gameweek is set in Step 5 (Details) of the league creation wizard. Defaults are:</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li><strong className="text-white">32-team and 16-team:</strong> GW31 (after a 30-GW league stage)</li>
            <li><strong className="text-white">8-team:</strong> GW36 (after a 35-GW league stage)</li>
          </ul>
          <p className="mt-2">You can override this to any GW between 31 and 36. The league stage automatically ends one GW before the playoff start. Chip set boundaries (Set 1 / Set 2) are calculated dynamically based on this value.</p>
        </div>
      ),
    },
  ];

  const scenarios = [
    {
      title: "Create a standard 32-team TVT league",
      steps: [
        "Click '+ New League' on the Superadmin dashboard.",
        "Step 1 — Sport: Select 'Football (FPL)'.",
        "Step 2 — Format: Select 'TVT'.",
        "Step 3 — Team Size: Select '32 Teams (2 groups of 16)'.",
        "Step 4 — Chips: Enable all 6 chips (Win-Win, Double Pointer, Challenge Chip, Score Lock, Comeback, Underdog).",
        "Step 5 — Details: Enter the league name (e.g. 'JPL Season 1'), slug (e.g. 'jpl-s1'), season (e.g. '2025-26'), and leave playoff start at the default GW31.",
        "Step 6 — Assign: Select an admin from the dropdown or skip and assign later.",
        "Click 'Create League'. The league is now live and the admin can start adding teams.",
      ],
    },
    {
      title: "Create a 16-team TVT league (JPL-TVT Merged Funnel)",
      steps: [
        "Click '+ New League' on the Superadmin dashboard.",
        "Step 1 — Sport: Select 'Football (FPL)'.",
        "Step 2 — Format: Select 'TVT'.",
        "Step 3 — Team Size: Select '16 Teams (1 group of 16)'.",
        "Step 4 — Chips: Enable the chips you want. Note: Challenge Chip is not available for 16-team format — the wizard disables it automatically.",
        "Step 5 — Details: Enter league name, slug, season. Playoff start defaults to GW31 (after a 30-GW league stage).",
        "Step 6 — Assign: Select an admin.",
        "Click 'Create League'. The league stage will be 30 GWs (2 full round-robins), with a full 8-GW playoff series (GW31–38) across Championship, Challenger, and Wooden Spoon brackets.",
      ],
    },
    {
      title: "Create an 8-team TVT league",
      steps: [
        "Click '+ New League' on the Superadmin dashboard.",
        "Step 1 — Sport: Select 'Football (FPL)'.",
        "Step 2 — Format: Select 'TVT'.",
        "Step 3 — Team Size: Select '8 Teams (1 group of 8)'.",
        "Step 4 — Chips: Enable the chips you want. Note: Challenge Chip is not available for 8-team format — the wizard disables it automatically.",
        "Step 5 — Details: Enter league name, slug, season. Playoff start defaults to GW36 (after the 35-GW league stage). Adjust if needed.",
        "Step 6 — Assign: Select an admin.",
        "Click 'Create League'. The league stage will be 35 GWs (5 full round-robins), with playoffs in GW36–38 (SF → Final + 3rd Place).",
      ],
    },
    {
      title: "Add an admin and assign them to a league",
      steps: [
        "Go to the 'Admins' tab on the Superadmin dashboard.",
        "Click '+ New Admin'.",
        "Enter the admin's name and email address. Note the generated temporary password.",
        "Share the credentials securely with the admin. They will be prompted to set a new password on first login.",
        "Find the newly created admin in the list and click 'Assign Leagues'.",
        "Select the league(s) you want them to manage and save.",
        "The admin can now log in and access their assigned leagues via the admin dashboard.",
      ],
    },
    {
      title: "View all leagues and check their status",
      steps: [
        "Log in at /signin with your superadmin credentials.",
        "You are redirected to the Superadmin dashboard, which shows the 'Leagues' tab by default.",
        "Each league row shows: name, slug, format, team count, current gameweek, and active status.",
        "Leagues shown as inactive are hidden from public listing but still accessible by their slug.",
        "Switch to the 'Admins' tab to see which admins are active and which leagues they are assigned to.",
        "Click any league's admin link or navigate to /admin/[leagueId] to view that league's admin dashboard.",
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <div className="flex items-center gap-3">
          <Link href="/superadmin" className="flex items-center gap-2">
            <Logo />
          </Link>
          <div>
            <span className="text-xl font-bold text-white">Platform Admin</span>
            <span className="ml-2 text-xs bg-yellow-400/20 text-yellow-400 px-2 py-0.5 rounded-full">Superadmin</span>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/superadmin" className="text-gray-300 hover:text-white transition">Dashboard</Link>
          <span className="text-yellow-400 font-semibold">Help</span>
          <button onClick={handleSignOut} className="text-gray-400 hover:text-white transition">Sign Out</button>
        </div>
      </nav>

      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-10">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-3">Superadmin Help</h1>
          <p className="text-gray-400">Platform management guide for superadmins</p>
        </div>

        {/* Tab bar */}
        <div className="flex gap-3 mb-8 justify-center">
          {(["faqs", "scenarios"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setOpenIndex(null); }}
              className={
                activeTab === tab
                  ? "bg-yellow-500 text-slate-900 px-5 py-2 rounded-lg font-semibold text-sm"
                  : "bg-white/5 text-gray-300 hover:bg-white/10 px-5 py-2 rounded-lg font-semibold text-sm transition"
              }
            >
              {tab === "faqs" ? "FAQs" : "Scenarios"}
            </button>
          ))}
        </div>

        {activeTab === "faqs" && (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-white mb-4">Platform Management</h2>
            {faqs.map((faq, i) => (
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
        )}

        {activeTab === "scenarios" && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold text-white mb-4">Step-by-Step Workflows</h2>
            {scenarios.map((s, i) => (
              <ScenarioCard key={i} number={i + 1} title={s.title} steps={s.steps} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
