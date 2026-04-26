"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

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

export default function AdminHelpPage() {
  const params = useParams();
  const leagueId = params.leagueId as string;

  const [isSuperadminViewer, setIsSuperadminViewer] = useState(false);
  const [teamSize, setTeamSize] = useState<number>(32);
  const [enabledChips, setEnabledChips] = useState<string[]>(["D", "W", "C"]);
  const [playoffStartGw, setPlayoffStartGw] = useState<number>(31);
  const [leagueName, setLeagueName] = useState<string>("");
  const [activeTab, setActiveTab] = useState<ActiveTab>("faqs");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (!d.authenticated || (d.type !== "admin" && d.type !== "superadmin")) {
          window.location.href = "/signin";
          return;
        }
        if (d.type === "superadmin") setIsSuperadminViewer(true);
      })
      .catch(() => { window.location.href = "/signin"; });
  }, []);

  useEffect(() => {
    fetch("/api/admin/my-leagues")
      .then((r) => {
        if (r.status === 401 || r.status === 403) { window.location.href = "/signin"; return null; }
        return r.json();
      })
      .then((data) => {
        if (!data) return;
        const leagues = data.leagues || [];
        const league = leagues.find((l: { slug: string }) => l.slug === leagueId);
        if (!league) return;
        if (league.name) setLeagueName(league.name);
        if (league.teamSize) setTeamSize(league.teamSize);
        if (league.playoffStartGw) setPlayoffStartGw(league.playoffStartGw);
        if (league.enabledChips) {
          try {
            const chips = typeof league.enabledChips === "string"
              ? JSON.parse(league.enabledChips)
              : league.enabledChips;
            setEnabledChips(chips);
          } catch {
            setEnabledChips(["D", "W", "C"]);
          }
        }
      })
      .catch(() => {});
  }, [leagueId]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  // Derived
  const leagueStageEnd = playoffStartGw - 1;
  const playoffGenerationGw = teamSize === 8 ? 35 : 30;
  const midpoint = Math.ceil(leagueStageEnd / 2);
  const set1Label = `GW1 – GW${midpoint}`;
  const set2Label = `GW${midpoint + 1} – GW${leagueStageEnd}`;
  const variantLabel = teamSize === 8 ? "8-Team" : teamSize === 16 ? "16-Team" : "32-Team";
  const groupDesc = teamSize === 32 ? "2 groups of 16 teams each" : teamSize === 16 ? "1 group of 16 teams" : "1 group of 8 teams";

  const faqs = [
    {
      question: "How do I add teams to my league?",
      answer: (
        <ol className="list-decimal list-inside space-y-1.5">
          <li>Go to your Admin Dashboard and click the <strong className="text-white">Teams</strong> tab.</li>
          <li>Click <strong className="text-white">Add Team</strong>.</li>
          <li>Fill in: team name, group assignment{teamSize === 32 ? " (A or B)" : ""}, and two players (name + FPL ID each).</li>
          <li>Set a temporary password for the team&apos;s login.</li>
          <li>Submit — the team login ID and temporary password are shown. Share these with the team.</li>
          <li>The team can log in at the Sign In page using the assigned team login ID.</li>
        </ol>
      ),
    },
    {
      question: "How do I bulk import teams?",
      answer: (
        <div className="space-y-2">
          <p>Go to the <strong className="text-white">Bulk Upload</strong> tab. Prepare an Excel or CSV file with the following columns:</p>
          <p className="font-mono text-xs bg-white/5 rounded p-2">TeamName · Group · Player1Name · Player1FplId · Player2Name · Player2FplId · Password</p>
          <ol className="list-decimal list-inside space-y-1.5 mt-2">
            <li>Upload the file in the Bulk Upload tab.</li>
            <li>Review the preview table — errors are highlighted in red (e.g., duplicate names, missing FPL IDs).</li>
            <li>Click <strong className="text-white">Import</strong> if all looks correct.</li>
            <li>Successful teams are created immediately. Failed rows show specific error reasons.</li>
            <li>Fix any failed rows individually using the Add Team form.</li>
          </ol>
        </div>
      ),
    },
    {
      question: "How do I process a gameweek?",
      answer: (
        <ol className="list-decimal list-inside space-y-1.5">
          <li>Wait for the FPL gameweek to finalise — all player scores are confirmed, usually 1–2 hours after the last match ends.</li>
          <li>Go to the <strong className="text-white">Scoring</strong> tab.</li>
          <li>Find the current GW in the list. It shows how many fixtures are pending.</li>
          <li>Click <strong className="text-white">Process GW{"{n}"}</strong>.</li>
          <li>The system fetches FPL scores (from cache), calculates team scores, applies captain doubles, chip effects, and updates standings.</li>
          <li>Processing takes 10–30 seconds. Review the results table to confirm everything looks correct.</li>
        </ol>
      ),
    },
    {
      question: "What does Force Reprocess do vs regular processing?",
      answer: (
        <div className="space-y-2">
          <p><strong className="text-white">Regular processing</strong> only runs if the GW has not been fully processed yet. It will skip GWs that already have results.</p>
          <p><strong className="text-white">Force Reprocess</strong> deletes all existing results for a GW and recalculates from scratch — using current captain selections, chip statuses, and cached FPL scores. Use this when:</p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li>You made a captain or chip override after the initial processing.</li>
            <li>FPL updated a score after the initial run (e.g., bonus points or a score correction).</li>
            <li>Results looked wrong and you want a clean recalculation.</li>
          </ul>
          <p className="text-yellow-300 text-xs mt-2">Always Force Reprocess after applying any override — changes do not apply retroactively without reprocessing.</p>
        </div>
      ),
    },
    {
      question: "How do I override a captain selection?",
      answer: (
        <ol className="list-decimal list-inside space-y-1.5">
          <li>Go to the <strong className="text-white">Captain</strong> tab.</li>
          <li>Filter by gameweek and find the team in question.</li>
          <li>Use the override form to select the correct player and enter a reason (e.g., &quot;Team missed deadline — auto-assigned lower scorer&quot;).</li>
          <li>Submit the override.</li>
          <li>Go to the <strong className="text-white">Scoring</strong> tab and Force Reprocess that GW to apply the updated captain to scores.</li>
        </ol>
      ),
    },
    {
      question: "How do I override a chip?",
      answer: (
        <div>
          <ol className="list-decimal list-inside space-y-1.5">
            <li>Go to the <strong className="text-white">Chips</strong> tab.</li>
            <li>Use the filter to find the team and the relevant set (Set 1 or Set 2).</li>
            <li>Use the override form to select the chip type, set status (available / used / wasted), and GW number.</li>
            <li>Enter a reason for the override.</li>
            <li>Submit.</li>
            <li>If the affected GW has already been scored, go to the <strong className="text-white">Scoring</strong> tab and Force Reprocess it.</li>
          </ol>
          {teamSize !== 32 && (
            <p className="text-red-400 text-xs mt-3">Note: The Challenge Chip (CC) is not available in {teamSize}-team leagues (requires 2 groups). Do not assign CC overrides in this league.</p>
          )}
        </div>
      ),
    },
    {
      question: "Can I bulk-import captains for playoff gameweeks (GW31+)?",
      answer: (
        <div className="space-y-2">
          <p>Yes. The captain import file supports GW1–38. Include a column for each gameweek (e.g. column header <code className="bg-white/10 px-1 rounded">31</code>) and mark the captain with <strong className="text-white">C</strong>.</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li>Playoff GWs are auto-created when you run <strong className="text-white">Generate Playoffs</strong>. You can import captains before or after that — missing GWs are created automatically during import.</li>
            <li>After importing, open the <strong className="text-white">Captain Override</strong> tab. The filter defaults to the latest GW that has entries, so GW31 captains will appear immediately.</li>
            <li>If the filter shows no entries, use the GW dropdown to select GW{playoffStartGw}.</li>
          </ul>
          <p className="text-yellow-300 text-xs mt-2">Always Force Reprocess the playoff GW after importing or overriding captains to apply changes to scores.</p>
        </div>
      ),
    },
    {
      question: `When should I generate playoffs?`,
      answer: (
        <div className="space-y-2">
          <p>Generate playoffs <strong className="text-white">after GW{leagueStageEnd} has been fully processed</strong> and the standings are final. For this {variantLabel} league ({groupDesc}), playoffs start at GW{playoffStartGw}.</p>
          <ol className="list-decimal list-inside space-y-1.5 mt-2">
            <li>Confirm GW{leagueStageEnd} is fully processed and standings look correct.</li>
            <li>Go to the <strong className="text-white">Playoffs</strong> tab.</li>
            <li>Click <strong className="text-white">Generate Playoffs</strong>. The bracket is seeded from final standings automatically.</li>
            <li>Visit the public Playoffs page to verify the bracket is correct before announcing it.</li>
            <li>After generating, advance each playoff GW using the Advance buttons (GW{playoffStartGw} through GW38) after each GW is fully scored.</li>
          </ol>
          {teamSize === 8 && (
            <p className="text-purple-300 text-xs mt-2">8-team: SF in GW36 (1-legged), Final + 3rd Place in GW37–38 (2-legged aggregate).</p>
          )}
          {teamSize === 16 && (
            <p className="text-purple-300 text-xs mt-2">16-team: Group sprints GW31–33 → Merger QFs + Seeding GW34 → SFs GW35–36 → Finals GW37–38. All 16 teams play until GW34; only 4 Challenger QF losers are eliminated.</p>
          )}
          {teamSize === 32 && (
            <p className="text-purple-300 text-xs mt-2">32-team: RO16 + Challenger-31 in GW31–32 → QF GW33–34 → SF GW35–36 → Final GW37–38.</p>
          )}
          <p className="text-yellow-300 text-xs mt-2">Do not generate early — the bracket is seeded from live standings. Regenerating is possible but should be done carefully.</p>
        </div>
      ),
    },
    {
      question: "What does the Captain Announcement toggle do?",
      answer: (
        <p>
          Found in the <strong className="text-white">Settings</strong> tab. When <strong className="text-white">enabled</strong>, the platform tracks and validates captain announcements — teams cannot submit a captain unless the announcement window is open. When <strong className="text-white">disabled</strong>, captain submission is blocked for all teams. Use this to control the window during which captains can be officially registered. Disable it after each GW deadline to close submissions.
        </p>
      ),
    },
    {
      question: "What does the Chip Announcement toggle do?",
      answer: (
        <p>
          Same concept as Captain Announcement but for chip declarations. Found in the <strong className="text-white">Settings</strong> tab. When enabled, teams can submit chip selections through the platform. When disabled, chip submissions are closed. Coordinate this toggle with the GW deadline — open it before the deadline, close it after processing is complete.
        </p>
      ),
    },
    {
      question: "How does the FPL cache work?",
      answer: (
        <div className="space-y-2">
          <p>The system caches FPL player scores per GW to avoid hammering the FPL API and to ensure consistency during processing. When you process a GW:</p>
          <ul className="list-disc list-inside space-y-1 ml-1">
            <li>The cache is checked first — if scores are already cached for that GW, they are used immediately.</li>
            <li>If not cached, the FPL API is called and the scores are cached for future use.</li>
          </ul>
          <p>You can view cache statistics and clear the cache per GW (or all at once) in the <strong className="text-white">Scoring</strong> tab. If scores seem stale or incorrect, clear the cache for that GW and Force Reprocess.</p>
        </div>
      ),
    },
    {
      question: "What happens if scoring is wrong and I reprocess?",
      answer: (
        <ol className="list-decimal list-inside space-y-1.5">
          <li>Identify the cause — wrong captain? Chip not applied? Stale FPL score?</li>
          <li>Apply any needed overrides first (Captain tab or Chips tab).</li>
          <li>If the FPL cache might be stale, clear the cache for that GW in the Scoring tab.</li>
          <li>Click <strong className="text-white">Force Reprocess</strong> on the affected GW.</li>
          <li>The system deletes all match results for that GW and recalculates from scratch.</li>
          <li>Standings are recalculated automatically. Review the updated results table.</li>
        </ol>
      ),
    },
    {
      question: "How do I handle a team dispute?",
      answer: (
        <ol className="list-decimal list-inside space-y-1.5">
          <li>Listen to both sides calmly and collect evidence (WhatsApp timestamps, dashboard screenshots).</li>
          <li>Check the <strong className="text-white">Captain</strong> tab — verify who was submitted as captain and whether it was before the deadline.</li>
          <li>Check the <strong className="text-white">Chips</strong> tab if the dispute involves chip points or chip eligibility.</li>
          <li>If an override is warranted, apply it (Captain or Chip Override form) with a clear reason.</li>
          <li>Force Reprocess the affected GW to apply changes.</li>
          <li>Communicate the outcome to both teams with a clear rationale. Document the decision in the override reason field.</li>
        </ol>
      ),
    },
  ];

  const scenarios = [
    {
      number: 1,
      title: "Setting up a new league (add teams, generate/import fixtures, enable announcements)",
      steps: [
        "Confirm your league has been created by your superadmin and you have admin access — check by logging in to your Admin Dashboard.",
        "Go to the Teams tab. Add teams one by one using Add Team, or use Bulk Upload for multiple teams at once.",
        "Share login credentials (team login ID + temp password) with each team.",
        teamSize === 32
          ? "Generate fixtures automatically: scroll to Quick Actions at the bottom of the Teams tab and click Generate Fixtures. The system creates a full home-and-away round-robin for both groups (GW1–30)."
          : teamSize === 16
          ? "Generate fixtures automatically: scroll to Quick Actions at the bottom of the Teams tab and click Generate Fixtures. The system creates a full home-and-away round-robin for all 16 teams (GW1–30)."
          : "Generate fixtures automatically: scroll to Quick Actions at the bottom of the Teams tab and click Generate Fixtures. The system creates 5 full round-robins for all 8 teams (GW1–35).",
        "Alternatively, go to Bulk Upload tab → upload fixtures manually (CSV/Excel: Home Team, Away Team, GW Number). Only needed if you want custom fixture scheduling.",
        "Go to Settings tab → enable both Captain Announcement and Chip Announcement toggles.",
        "Confirm all teams join the official FPL mini-league before GW1 deadline.",
        "You are now ready for GW1 — remind teams to submit their captains before the first FPL deadline.",
      ],
    },
    {
      number: 2,
      title: "End-of-gameweek processing workflow (step by step)",
      steps: [
        "Wait for the FPL GW to finalise — all scores confirmed, usually 1–2 hours after the last match.",
        "Check the Captain tab — confirm all teams have valid captain submissions. Override any missing or invalid captains.",
        "Check the Chips tab — confirm any declared chips are registered correctly.",
        "Go to Scoring tab → find the current GW → click Process GW.",
        "Wait 15–30 seconds. Review the results table — verify scores and match outcomes look correct.",
        "If anything looks wrong, apply the relevant override (Captain or Chips tab) then Force Reprocess.",
        "Once confirmed, you can close the Captain and Chip Announcement toggles in Settings until the next GW.",
      ],
    },
    {
      number: 3,
      title: "Handling a captain override dispute",
      steps: [
        "A team claims their captain was submitted on time but was not recorded.",
        "Check the WhatsApp group logs for the exact timestamp of the announcement.",
        "If the announcement was before the FPL deadline: go to Captain tab → find the team → select the correct player → submit override with reason (e.g., 'Captain submitted on time per WhatsApp log at 4:27 PM').",
        "If the announcement was after the deadline: the default rule applies — lower-scoring player is captain. Explain this to the team politely.",
        "After applying any valid override, go to Scoring tab and Force Reprocess the affected GW.",
        "Notify both teams of the outcome with your reasoning.",
      ],
    },
    {
      number: 4,
      title: `Generating playoffs and verifying the bracket`,
      steps: [
        `Ensure GW${leagueStageEnd} is fully processed and all standings are final (no pending reprocesses).`,
        "Go to the Playoffs tab in your Admin Dashboard.",
        "Click Generate Playoffs. The system seeds the bracket from the final standings automatically.",
        "Navigate to the public-facing Playoffs page (via the nav link or the ← Leagues link) to visually verify the bracket.",
        `For a ${variantLabel} league, confirm the correct number of teams per round and that seedings match the final standings.`,
        "Announce the bracket to all teams.",
      ],
    },
    {
      number: 5,
      title: "Bulk importing teams from Excel",
      steps: [
        "Prepare your Excel file with columns: TeamName, Group, Player1Name, Player1FplId, Player2Name, Player2FplId, Password.",
        teamSize === 32
          ? "Group column must be A or B — ensure teams are split correctly between the two groups."
          : "Group column should be A for all teams (single group league).",
        "Go to Bulk Upload tab → select the Teams upload section.",
        "Upload the file and review the preview table — rows with errors are highlighted in red.",
        "If all looks correct, click Import. Teams are created immediately.",
        "Any failed rows show specific error reasons (e.g., duplicate team name, invalid FPL ID). Fix and re-upload individually via Add Team.",
        "Confirm the Teams tab shows the correct total number of teams before proceeding.",
      ],
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/admin" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            TVT
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">Admin Dashboard</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          {isSuperadminViewer && (
            <Link href="/superadmin" className="text-orange-400 font-semibold transition">
              ← Platform Admin
            </Link>
          )}
          <Link href="/admin" className="text-yellow-400 font-semibold transition">← Leagues</Link>
          <Link href={`/admin/${leagueId}`} className="text-gray-300 hover:text-white transition">Dashboard</Link>
          <Link href={`/admin/${leagueId}/help`} className="text-yellow-400 font-semibold transition">Help</Link>
          <button onClick={handleSignOut} className="text-gray-300 hover:text-white transition">Sign Out</button>
        </div>
      </nav>

      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 rounded-full bg-yellow-400/10 border border-yellow-400/20 px-4 py-1.5 text-sm text-yellow-400 font-medium mb-4">
            {variantLabel} Format · Admin Guide
          </div>
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-3">Admin Help &amp; Guidance</h1>
          <p className="text-gray-400">
            {leagueName ? `${leagueName} · ` : ""}FAQs and workflows for league administrators
          </p>
          <p className="text-xs text-gray-500 mt-2">
            League stage: GW1–GW{leagueStageEnd} · Playoffs from GW{playoffStartGw} · Chips: {set1Label} (Set 1), {set2Label} (Set 2)
          </p>
        </div>

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
          <div className="space-y-2">
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

        {/* Scenarios Tab */}
        {activeTab === "scenarios" && (
          <div className="space-y-4">
            {scenarios.map((s) => (
              <ScenarioCard key={s.number} number={s.number} title={s.title} steps={s.steps} />
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="mt-10 text-center text-sm text-gray-500">
          Need more help? Contact your superadmin or check the{" "}
          <Link href="/admin" className="text-yellow-400 hover:text-yellow-300 transition">
            Leagues Dashboard
          </Link>.
        </div>
      </div>
    </div>
  );
}
