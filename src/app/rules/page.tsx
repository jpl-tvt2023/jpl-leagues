"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function RulesPage() {
  const router = useRouter();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    // Check auth status — redirect to signin if not authenticated
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (res.ok && data.authenticated) {
          setIsLoggedIn(true);
          setIsAdmin(data.type === "admin" || data.type === "superadmin");
        } else {
          router.replace("/signin");
          return;
        }
      } catch {
        router.replace("/signin");
        return;
      }
      setIsChecking(false);
    };
    checkAuth();
  }, [router]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  if (isChecking) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900 flex items-center justify-center">
        <div className="text-white">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href={isAdmin ? "/admin" : isLoggedIn ? "/dashboard" : "/"} className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            TVT
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">Fantasy Super League</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          {isAdmin ? (
            <Link href="/admin" className="text-gray-300 hover:text-white transition">Home</Link>
          ) : isLoggedIn ? (
            <Link href="/dashboard" className="text-gray-300 hover:text-white transition">Dashboard</Link>
          ) : (
            <Link href="/" className="text-gray-300 hover:text-white transition">Home</Link>
          )}
          <Link href="/standings" className="text-gray-300 hover:text-white transition">
            Standings
          </Link>
          <Link href="/fixtures" className="text-gray-300 hover:text-white transition">
            Fixtures
          </Link>
          <Link href="/playoffs" className="text-gray-300 hover:text-white transition">
            Playoffs
          </Link>
          <Link href="/rules" className="text-yellow-400 font-semibold transition">
            Rules
          </Link>
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

      <div className="mx-auto max-w-4xl px-6 py-12">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-white mb-4">TVT Rules & Regulations</h1>
          <p className="text-gray-400">Everything you need to know about the TVT Fantasy Super League</p>
        </div>

        <div className="space-y-8">
          {/* Section A */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
            <div className="flex items-center gap-3 mb-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/20 text-lg font-bold text-purple-400">
                A
              </span>
              <h2 className="text-2xl font-bold text-white">Team Structure & Registration</h2>
            </div>
            <ul className="space-y-4 text-gray-300">
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Format:</strong> 32 teams total, split into 2 groups (Group A & B) of 16 teams each.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Squad:</strong> 2 players per team. Each team faces group opponents twice in the League Stage.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Naming Convention:</strong> Must follow <code className="bg-white/10 px-2 py-0.5 rounded">Abbreviation — Player Name</code> (e.g., DM — Rahul).</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Penalty:</strong> Incorrect naming results in the lowest-scoring partner being forced as captain.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>League Entry:</strong> Players must join the official admin league before the deadline or their scores won&apos;t count.</span>
              </li>
            </ul>
          </section>

          {/* Section B */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
            <div className="flex items-center gap-3 mb-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-500/20 text-lg font-bold text-orange-400">
                B
              </span>
              <h2 className="text-2xl font-bold text-white">Scoring & Captaincy</h2>
            </div>
            <ul className="space-y-4 text-gray-300">
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Match Points:</strong> Win = 2 points, Draw = 1 point, Loss = 0 points.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Team Score:</strong> Combined score of both members minus any transfer hits (negatives).</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Captaincy:</strong> One member is designated as captain per Gameweek.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Effect:</strong> Captain&apos;s individual score (and their transfer hits) is doubled.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Deadline:</strong> Must be announced in the WhatsApp group 1 second before the official deadline (e.g., 4:29:59 PM).</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Announcement Penalties:</strong> Spamming or modifying other teams&apos; entries results in a -1 league point deduction (GW1–30) or a -8 score deduction (GW31+).</span>
              </li>
            </ul>
          </section>

          {/* Section C */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
            <div className="flex items-center gap-3 mb-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/20 text-lg font-bold text-green-400">
                C
              </span>
              <h2 className="text-2xl font-bold text-white">The Two Phases</h2>
            </div>
            
            <div className="mb-6">
              <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 1: League Stage (GW 1–30)</h3>
              <ul className="space-y-3 text-gray-300 ml-4">
                <li className="flex gap-3">
                  <span className="text-purple-400">•</span>
                  <span><strong>Captaincy Limit:</strong> Each player has 15 chips. Once exhausted, that player cannot be captain again until the Play-offs.</span>
                </li>
                <li className="flex gap-3">
                  <span className="text-purple-400">•</span>
                  <span><strong>Qualification:</strong></span>
                </li>
                <li className="ml-6 space-y-1">
                  <div className="text-green-400">Rank 1–8: Qualify for TVT Title Play-offs</div>
                  <div className="text-yellow-400">Rank 9–14: Qualify for Challenger Series</div>
                  <div className="text-red-400">Rank 15–16: Eliminated</div>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="text-lg font-semibold text-yellow-400 mb-3">Phase 2: Play-offs (GW 31–38)</h3>
              <ul className="space-y-3 text-gray-300 ml-4">
                <li className="flex gap-3">
                  <span className="text-purple-400">•</span>
                  <span><strong>TVT Title Play-offs:</strong> 2-legged ties (aggregate score). Losers drop into the Challenger Series.</span>
                </li>
                <li className="flex gap-3">
                  <span className="text-purple-400">•</span>
                  <span><strong>Challenger Series:</strong> A mix of single-leg knockouts and survival rounds to determine 3rd place down to 12th.</span>
                </li>
                <li className="flex gap-3">
                  <span className="text-purple-400">•</span>
                  <span><strong>Captaincy:</strong> No limit on chips; any player can captain any number of times.</span>
                </li>
              </ul>
            </div>
          </section>

          {/* Section D */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
            <div className="flex items-center gap-3 mb-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-500/20 text-lg font-bold text-yellow-400">
                D
              </span>
              <h2 className="text-2xl font-bold text-white">Special TVT Chips</h2>
            </div>
            <p className="text-gray-400 mb-6">Teams get two sets of chips: Set 1 (GW1–15) and Set 2 (GW16–30). They do not carry forward.</p>
            
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="px-4 py-3 text-left font-semibold text-white">Chip</th>
                    <th className="px-4 py-3 text-left font-semibold text-white">Rule / Usage</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  <tr className="border-b border-white/5">
                    <td className="px-4 py-3 font-medium text-purple-400">Double Pointer</td>
                    <td className="px-4 py-3">Doubles match points (Win = 4). Rank 1–8 use only against Top 8. Rank 9–16 use only against higher-ranked teams.</td>
                  </tr>
                  <tr className="border-b border-white/5">
                    <td className="px-4 py-3 font-medium text-orange-400">Challenge Chip</td>
                    <td className="px-4 py-3">Play a second &quot;Challenge Fixture&quot; against a Top 2 team from the opposite group for extra points.</td>
                  </tr>
                  <tr className="border-b border-white/5">
                    <td className="px-4 py-3 font-medium text-green-400">Win-Win</td>
                    <td className="px-4 py-3">Standard TVT chip (Usage per set rules).</td>
                  </tr>
                </tbody>
              </table>
            </div>
            
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400">
              <strong>Chip Penalty:</strong> Claiming a chip you don&apos;t have results in a -8 point hit.
            </div>
          </section>

          {/* Section E */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
            <div className="flex items-center gap-3 mb-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/20 text-lg font-bold text-red-400">
                E
              </span>
              <h2 className="text-2xl font-bold text-white">Negative Hits & Bonus Points</h2>
            </div>
            <ul className="space-y-4 text-gray-300">
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Negative Hit Cap:</strong> Max -12 points per player. Exceeding this triggers a -1 league point deduction for the team.</span>
              </li>
              <li className="flex gap-3">
                <span className="text-yellow-400">•</span>
                <span><strong>Bonus Point:</strong> Earned if a team wins by 75+ points AND has the highest winning margin in their group for that GW.</span>
              </li>
            </ul>
          </section>

          {/* Section F */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
            <div className="flex items-center gap-3 mb-6">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/20 text-lg font-bold text-blue-400">
                F
              </span>
              <h2 className="text-2xl font-bold text-white">Tie-Breaker Hierarchy</h2>
            </div>
            <p className="text-gray-400 mb-6">If teams are tied, the following order determines the winner:</p>
            
            <div className="grid md:grid-cols-2 gap-6">
              <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                <h3 className="text-lg font-semibold text-green-400 mb-3">League Stage</h3>
                <ol className="space-y-2 text-gray-300 list-decimal list-inside">
                  <li>Overall Points</li>
                  <li>Max Wins</li>
                  <li>Head-to-Head</li>
                  <li>Bonus Points</li>
                </ol>
              </div>
              
              <div className="p-4 rounded-lg bg-white/5 border border-white/10">
                <h3 className="text-lg font-semibold text-purple-400 mb-3">Play-offs</h3>
                <ol className="space-y-2 text-gray-300 list-decimal list-inside">
                  <li>TVT Captain&apos;s Points</li>
                  <li>TVT Captain&apos;s FPL Captain Points</li>
                  <li>Partner&apos;s FPL Captain Points</li>
                  <li>FPL Vice-Captain Points</li>
                  <li>League Rank</li>
                </ol>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
