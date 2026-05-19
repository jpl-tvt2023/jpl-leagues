"use client";

import { useState } from "react";
import Link from "next/link";
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
  leagueSlug: string;
}

export function AuctionHelp({ userRole, leagueSlug }: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("faqs");
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const generalFaqs: FaqEntry[] = [
    {
      question: "What is the JPL Auction format?",
      answer: (
        <p>
          Each manager starts with a <strong className="text-white">purse</strong> and builds a squad of up to <strong className="text-white">14 FPL players</strong> by bidding in live auctions. Every gameweek, your squad scores the combined FPL points of your owned players. Teams are ranked each GW by their score and earn cash payouts that go back into the purse. The season winner is the team with the highest cumulative points across all 38 gameweeks.
        </p>
      ),
    },
    {
      question: "How do I view standings, players, finance, and trades?",
      answer: (
        <p>
          Use the top navigation. <strong className="text-white">Standings</strong> ranks teams by cumulative points. <strong className="text-white">GW Results</strong> shows per-gameweek scores and squad breakdowns. <strong className="text-white">Players</strong> lists every FPL player with prices and current owners. <strong className="text-white">Marketplace</strong> is where trades are proposed and accepted. <strong className="text-white">Finance</strong> shows your purse ledger (auctions, payouts, trades, redemptions). Most pages are publicly viewable; trade actions require sign-in.
        </p>
      ),
    },
    {
      question: "How are points calculated each gameweek?",
      answer: (
        <p>
          Your GW score = sum of FPL points from your <strong className="text-white">active</strong> owned players. Players you have marked as <strong className="text-yellow-400">deadwood</strong> remain in your squad but contribute zero. For leagues with the <strong className="text-white">PL Club Auction</strong> enabled, the total is <strong className="text-white">Raw + Synergy + Club result</strong>. Once scored, payouts are credited to your purse based on your GW rank. See the <Link href={`/${leagueSlug}/rules`} className="text-yellow-400 hover:text-yellow-300">Rules page</Link> for the full payout schedule.
        </p>
      ),
    },
    {
      question: "What is the PL Club auction and how does it work?",
      answer: (
        <div className="space-y-2">
          <p>
            Before the player auction begins, each fantasy team buys <strong className="text-white">one Premier League club</strong> in a separate auction. The system <strong className="text-white">randomly nominates</strong> clubs one at a time; bidders place bids; the highest bidder wins. If nobody bids on a nominated club, it goes unsold and is re-nominated in a round-2 pass (only club-less teams can bid in round 2).
          </p>
          <p>
            Clubs are <strong className="text-white">non-tradeable</strong> — you own that club for the entire season. Your team displays as the owned club&apos;s name everywhere (e.g. &quot;Team 5&quot; → &quot;Arsenal&quot;), with a tier-coloured chip beside it.
          </p>
        </div>
      ),
    },
    {
      question: "How does the ×1.5 club synergy multiplier work?",
      answer: (
        <div className="space-y-2">
          <p>
            Any owned player whose PL club matches your owned club earns a <strong className="text-yellow-300">+50% bonus</strong> on their raw GW points. The synergy follows the player&apos;s PL club <strong className="text-white">at the time of the GW</strong>, not their current club.
          </p>
          <p>
            If a player transfers mid-season, the <strong className="text-white">previous owner keeps synergy</strong> on every GW the player completed at the old club, and the <strong className="text-white">new owner gains synergy</strong> from the transfer GW onward. Example: Mbeumo plays GW1-15 for Brentford then signs for Man Utd before GW16 — the Brentford owner keeps GW1-15 synergy on Mbeumo, the Man Utd owner picks up GW16+.
          </p>
          <p>
            Synergy applies only to GW scoring; it does <strong className="text-white">not</strong> compound into FMV, squad value, or trade economics.
          </p>
        </div>
      ),
    },
    {
      question: "How does the club result bonus work?",
      answer: (
        <div className="space-y-2">
          <p>
            Every GW your owned club wins or draws a real-PL fixture, you earn a per-fixture bonus based on the club&apos;s tier:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li><strong className="text-yellow-300">Top 8</strong> (last season&apos;s 1-8) — Win +2 / Draw +1 per fixture.</li>
            <li><strong className="text-blue-300">Mid</strong> (last season&apos;s 9-17) — Win +3 / Draw +1.</li>
            <li><strong className="text-emerald-300">Promoted</strong> (3 newly-promoted clubs) — Win +4 / Draw +2.</li>
          </ul>
          <p>Double Gameweek = bonus paid per fixture (so 2× in a DGW). Blank Gameweek = no fixture, no bonus.</p>
        </div>
      ),
    },
    {
      question: "What happens if I own a player who transfers out of the Premier League mid-season?",
      answer: (
        <p>
          Their historical points (and synergy) stay on your record for any GWs already scored. Going forward they score 0 (no longer in FPL). You can <strong className="text-white">release</strong> them for a 50% refund just like any other player — see the Releases section in the Rules.
        </p>
      ),
    },
    {
      question: "What happens when admin reprocesses a historical GW after a player transfer?",
      answer: (
        <p>
          Reprocessing uses the player&apos;s PL club <strong className="text-white">at the time the GW was originally scored</strong> (snapshotted in the scoring breakdown) rather than the live FPL bootstrap. So mid-season transfers do NOT retroactively re-route synergy on already-scored GWs. If a player has since left the PL entirely (missing from the bootstrap), the last-known synergy bonus is preserved. In the rare case automatic preservation isn&apos;t enough, superadmin can edit per-row synergy / club-result via the <em>Score Adjustments</em> tab — every change is audit-logged with a reason.
        </p>
      ),
    },
  ];

  const teamFaqs: FaqEntry[] = [
    {
      question: "How does nomination work in an auction session?",
      answer: (
        <div className="space-y-2">
          <p>
            Auction sessions run in <strong className="text-white">snake order</strong>: when it&apos;s your turn, you nominate a player and a starting bid. All other teams have a fixed window to bid; the highest bid at the end wins. If only your bid is placed, you win at your starting price.
          </p>
          <p>
            You have a <strong className="text-white">designated nomination timer</strong> (default 60 seconds) once it becomes your turn. If you don&apos;t nominate in time, the system will auto-nominate from your <strong className="text-white">wishlist</strong>. If your wishlist has nothing eligible, you <strong className="text-red-400">lose a squad slot</strong> — see the next FAQ.
          </p>
        </div>
      ),
    },
    {
      question: "What happens if I fail to nominate in time? (Slot deduction)",
      answer: (
        <div className="space-y-2">
          <p>
            If your nomination timer expires <strong className="text-white">and</strong> your wishlist has no eligible players to auto-nominate, your maximum squad size shrinks by one — your <strong className="text-red-400">penaltySlots</strong> counter increments and your effective cap drops from <strong className="text-white">14 → 13 → 12 → …</strong>.
          </p>
          <p>
            You can <strong className="text-white">buy back</strong> a lost slot from the auction interface:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong className="text-white">£2.5M</strong> — if redeemed within the <strong className="text-white">same auction cycle</strong> in which it was lost.
            </li>
            <li>
              <strong className="text-white">£5M</strong> — if redeemed in a <strong className="text-white">later auction cycle</strong>.
            </li>
          </ul>
          <p>
            Until redeemed, the slot stays unavailable and your effective max stays reduced. The slot-status indicator on the Auction page shows your live deduction count + the cheapest redeemable cost.
          </p>
        </div>
      ),
    },
    {
      question: "What's the difference between open, locked, and penalty slots?",
      answer: (
        <div className="space-y-2">
          <p>The squad-slot indicator on the Auction and Squad pages shows three distinct concepts:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li><strong className="text-green-300">Open slots</strong> — empty spots in your squad you can still fill via auction. <code className="text-gray-200">open = effectiveMax − active</code>.</li>
            <li><strong className="text-red-300">Penalty slots (✕)</strong> — slots you lost to missed nominations. Recovered by redeeming with purse (£2.5M same cycle / £5M later).</li>
            <li><strong className="text-purple-300">Locked slots (🔒)</strong> — slots 15 and 16 that aren&apos;t yet unlocked. Unlock with purse money (£10M for slot 15, £25M for slot 16) AFTER the initial auction completes.</li>
          </ul>
          <p>Penalty (red ✕) and locked (grey 🔒) are visually distinct on screen — different mechanics, different fix paths.</p>
        </div>
      ),
    },
    {
      question: "How do I unlock slot 15 and 16?",
      answer: (
        <div className="space-y-2">
          <p>
            The initial auction fills <strong className="text-white">14 active players</strong>. After it completes, you can spend purse money to expand your squad:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li><strong className="text-purple-300">£10M</strong> — unlock slot 15.</li>
            <li><strong className="text-purple-300">£25M</strong> — unlock slot 16 (only available after slot 15 is unlocked).</li>
          </ul>
          <p>
            Both unlocks are <strong className="text-white">non-refundable</strong>. The absolute squad ceiling is 16; you can&apos;t buy past that. A full league reset (admin action) clears bonus slots back to 0.
          </p>
        </div>
      ),
    },
    {
      question: "How do I avoid losing a slot? (Wishlist)",
      answer: (
        <p>
          Maintain a <strong className="text-white">wishlist</strong> of players you&apos;d be happy to acquire at a default starting price. When your nomination timer expires, the system auto-nominates the highest-ranked still-available player from your list. Keep at least a handful of realistic options at the top so you never get caught short. You can edit your wishlist any time before the cycle ends.
        </p>
      ),
    },
    {
      question: "How do trades and releases work?",
      answer: (
        <p>
          Trades happen on the <strong className="text-white">Marketplace</strong> — propose a swap of players (and optional cash) with another team. Both sides must accept. Releases drop a player back into the free-agent pool; you get a <strong className="text-white">50% refund</strong> of their purchase price back to your purse. Released players become available again at the next mini-auction.
        </p>
      ),
    },
    {
      question: "What's the difference between Standings and GW Results?",
      answer: (
        <p>
          <strong className="text-white">Standings</strong> ranks teams by their season totals (cumulative points, purse, squad value). <strong className="text-white">GW Results</strong> focuses on a single gameweek — who scored what that week, how the payouts landed, and which players contributed for each team. Use GW Results to scout opponents&apos; weekly form and verify your own payout history.
        </p>
      ),
    },
    {
      question: "How do notifications work?",
      answer: (
        <p>
          The bell icon in the top nav surfaces relevant events for your team. Today it covers <strong className="text-white">trade proposals</strong> (received, accepted, rejected, countered) — clicking opens the Marketplace. Expanded coverage for finance ledger entries and gameweek processing is on the roadmap.
        </p>
      ),
    },
  ];

  const publicScenarios: ScenarioEntry[] = [
    {
      number: 1,
      title: "Browse a league as a guest",
      steps: [
        "Open Standings to see the season leaderboard.",
        "Open GW Results and pick any processed gameweek to inspect scores and team breakdowns.",
        "Open Players to browse the full FPL pool and see which JPL team owns each player.",
      ],
    },
    {
      number: 2,
      title: "The PL Club auction — from random nomination to final ownership",
      steps: [
        "Admin schedules a separate club-auction session, typically 1 hour or 1 day before the initial player auction.",
        "When the session starts, the system randomly orders all 20 PL clubs and auto-nominates the first one.",
        "Any team that doesn't yet own a club may bid. Same purse, same bid timer rules as the player auction.",
        "Highest bidder wins the club at their final bid. No bids → club goes unsold and re-nominates in round 2.",
        "Round 2 re-shuffles the unsold clubs; only club-less teams can bid. Repeat until every team has a club.",
        "After the session, every team's display name flips to their owned club (e.g. 'Team 5' → 'Arsenal') with a tier chip.",
      ],
    },
  ];

  const teamScenarios: ScenarioEntry[] = [
    {
      number: 1,
      title: "Prepare for an auction cycle",
      steps: [
        "Open Auction and review the snake order — note when your turn comes up.",
        "Open Players, filter by position or team, and add your priorities to your Wishlist.",
        "Make sure your wishlist has more than one option at the top — auto-nomination will only fire if at least one eligible player remains.",
        "When your turn arrives, nominate within the timer (default 60s) and set a starting bid.",
      ],
    },
    {
      number: 2,
      title: "Recover a lost slot",
      steps: [
        "Open Auction — if your penalty slots indicator is above 0, you've lost at least one slot.",
        "Click the redeem-slot action. The price is £2.5M if you're still in the same auction cycle the slot was lost in, otherwise £5M.",
        "Confirm the redemption — your effective max squad size goes back up by 1 immediately.",
        "Use the recovered slot to bid in the current or next auction.",
      ],
    },
    {
      number: 3,
      title: "Propose a trade",
      steps: [
        "Open Marketplace and click New Trade Proposal.",
        "Pick the target team from the dropdown.",
        "Select the player(s) you're offering from your squad and the player(s) you're requesting from theirs.",
        "Optionally add cash (positive = you pay, negative = you receive). The FMV floor check ensures both sides receive ≥80% of what they give.",
        "Submit. The recipient is notified via the bell icon and can accept, reject, or counter.",
      ],
    },
    {
      number: 4,
      title: "Reprocessing a gameweek after a player transferred",
      steps: [
        "Admin clicks Reprocess on a previously-scored GW from the Scoring tab.",
        "The scorer fetches the latest FPL bootstrap and recomputes raw points and synergy.",
        "For owned players who are no longer in the FPL bootstrap (transferred out of the PL), the scorer preserves their previously-stored synergy bonus rather than dropping it to 0.",
        "Total = Raw + Synergy + Club result is recomputed and standings re-rank.",
        "If automatic preservation isn't enough (rare), superadmin can edit per-row synergy / club-result from Superadmin → Score Adjustments. Every change is audit-logged with a reason.",
      ],
    },
  ];

  return (
    <>
      <HelpTabBar activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === "faqs" && (
        <div className="space-y-6">
          <div>
            <SectionDivider title="General" color="yellow" />
            <div className="space-y-3">
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

          {userRole !== "public" && (
            <div>
              <SectionDivider title="Team Members" color="purple" />
              <div className="space-y-3">
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
            <PublicSignInPrompt message="Sign in to see team-specific FAQs about nomination timers, slot deduction, trades, and your wishlist." />
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
            <PublicSignInPrompt message="Sign in to see step-by-step scenarios for auctions, slot redemption, and trades." />
          )}
        </div>
      )}
    </>
  );
}
