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
          Your GW score = sum of FPL points from your <strong className="text-white">active</strong> owned players. Players you have marked as <strong className="text-yellow-400">deadwood</strong> remain in your squad but contribute zero. Once scored, payouts are credited to your purse based on your GW rank. See the <Link href={`/${leagueSlug}/rules`} className="text-yellow-400 hover:text-yellow-300">Rules page</Link> for the full payout schedule.
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
            Until redeemed, the slot stays unavailable and your effective max stays reduced. The current <em>Penalty slots: N</em> indicator on the Auction page shows your live deduction count.
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
