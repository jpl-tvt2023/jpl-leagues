"use client";

import { GW_PAYOUTS, MINIMUM_FLOOR_PAYOUT } from "@/lib/formats/auction/economy";
import { RuleItem, SectionHeader, formatPayout } from "./shared";

export function AuctionRules({ tier = "complete" }: { tier?: "primary" | "complete" }) {
  // Primary tier disables trades and slot 16/17/18 expansion — hide those rules so they aren't
  // shown for a feature the league can't use.
  const primary = tier === "primary";
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="A" color="green" title="Budget & Purse" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Each manager starts with an <strong className="text-white">initial budget</strong> (purse) set by the league.</RuleItem>
          <RuleItem>Your purse increases via GW payouts, release refunds, and trade income.</RuleItem>
          <RuleItem>Your purse decreases via player purchases and trade payments.</RuleItem>
          <RuleItem>The purse is the currency of the league — manage it wisely across auctions and trades.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="purple" title="Auction Sessions" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>The <strong className="text-white">Initial Auction</strong> fills all squads before the season begins. Teams nominate players in snake-draft order.</RuleItem>
          <RuleItem><strong className="text-white">Mini-Auctions</strong> occur at designated points during the season. Any released players return to the pool.</RuleItem>
          <RuleItem>Each nominated player goes to the highest bidder. If only one bid is placed, it wins at the minimum bid price.</RuleItem>
          <RuleItem>You cannot bid more than your remaining purse allows.</RuleItem>
          <RuleItem>The snake order for nominations reverses each round: bottom-ranked teams nominate first in mini-auctions.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="C" color="yellow" title="Squad Requirements" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Initial auction fills <strong className="text-white">15 active players</strong> per squad. Minimum position requirements: <strong className="text-white">1 GK, 3 DEF, 3 MID, 1 FWD</strong>.</RuleItem>
          {!primary && (
            <RuleItem>
              <strong className="text-white">Bonus slots (slots 16, 17 &amp; 18):</strong> after the initial auction completes, teams can unlock additional squad slots with purse money — <strong className="text-purple-300">£10M for slot 16</strong>, <strong className="text-purple-300">£20M for slot 17</strong>, then <strong className="text-purple-300">£30M for slot 18</strong>. Sequential — each slot only unlocks after the previous one. Locked slots cannot be filled during the initial auction.
            </RuleItem>
          )}
          <RuleItem>
            <strong className="text-white">Penalty slots:</strong> if you miss a nomination with an empty wishlist, your effective squad cap drops by 1. Redeem from your purse — <strong className="text-cyan-300">£2.5M same cycle</strong> / <strong className="text-cyan-300">£5M later cycle</strong>.
          </RuleItem>
          <RuleItem>Effective max squad size = 15 (base) + unlocked bonus slots − penalty slots. Absolute ceiling is 18.</RuleItem>
          <RuleItem>No FPL player can be owned by more than one team in the same league simultaneously.</RuleItem>
          <RuleItem>Players marked as <strong className="text-yellow-400">deadwood</strong> remain in your squad but do not score. They still count toward your squad size.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="D" color="blue" title="Scoring & Payouts" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Each gameweek, your squad score is the <strong className="text-white">sum of all active FPL points</strong> earned by your owned players (deadwood excluded).</RuleItem>
          <RuleItem>Teams are <strong className="text-white">ranked each GW</strong> by their squad score. Top-ranked teams earn the highest payouts.</RuleItem>
          <RuleItem>Payout amounts are credited to your purse at the end of each gameweek.</RuleItem>
          <RuleItem>The <strong className="text-white">overall standings</strong> are determined by cumulative total FPL points scored across all gameweeks.</RuleItem>
        </ul>

        <div className="mt-5 rounded-xl border border-white/10 bg-white/5 overflow-hidden">
          <div className="px-4 py-2 text-xs uppercase tracking-wider text-gray-400 border-b border-white/10">
            GW Payout Schedule
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-gray-400">
                <th className="text-left py-2 px-4">Rank</th>
                <th className="text-right py-2 px-4">Payout</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(GW_PAYOUTS)
                .map(([rank, amount]) => [Number(rank), amount] as const)
                .sort((a, b) => a[0] - b[0])
                .map(([rank, amount]) => (
                  <tr key={rank} className="border-t border-white/5">
                    <td className="py-2 px-4 text-white font-mono">#{rank}</td>
                    <td className="py-2 px-4 text-right font-mono text-green-300">{formatPayout(amount)}</td>
                  </tr>
                ))}
              <tr className="border-t border-white/5">
                <td className="py-2 px-4 text-white font-mono">#11+</td>
                <td className="py-2 px-4 text-right font-mono text-gray-300">{formatPayout(MINIMUM_FLOOR_PAYOUT)} <span className="text-xs text-gray-500">(floor)</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {!primary && (
        <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
          <SectionHeader letter="E" color="orange" title="Player Trades" />
          <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
            <RuleItem>Any manager can <strong className="text-white">propose a trade</strong> to another team — offering players and/or cash in exchange for players.</RuleItem>
            <RuleItem>The target team must <strong className="text-white">accept</strong> the trade, after which it awaits admin approval before executing.</RuleItem>
            <RuleItem>Trades are subject to an <strong className="text-white">80% Fair Market Value (FMV) floor</strong>: the total value given by each side must be at least 80% of what they receive.</RuleItem>
            <RuleItem>FMV is calculated based on purchase price and cumulative points earned.</RuleItem>
            <RuleItem>A <strong className="text-white">5% transfer tax</strong> is charged on all cash received in a trade. If you receive £10M, you keep £9.5M.</RuleItem>
            <RuleItem>Both squads must maintain valid size (8–18 players, depending on bonus slots) and position minimums after any trade.</RuleItem>
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="F" color="red" title="Player Releases" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>You can <strong className="text-white">request a release</strong> for any active player at any time from your squad page.</RuleItem>
          <RuleItem>The released player continues scoring for your team until the release is finalized.</RuleItem>
          <RuleItem>Releases are finalized at the <strong className="text-white">start of the next mini-auction</strong>. Upon finalization, you receive a <strong className="text-white">50% refund</strong> of the player&apos;s purchase price.</RuleItem>
          <RuleItem>The other 50% is forfeited — releasing is a cost, not a full recovery.</RuleItem>
          <RuleItem>You can <strong className="text-white">cancel a pending release</strong> any time before the mini-auction begins.</RuleItem>
          <RuleItem>Released players re-enter the player pool and are available in the next mini-auction.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="G" color="green" title="PL Club Ownership (opt-in)" />
        <p className="text-xs text-gray-500 mb-3">Only applies to leagues with the PL Club Auction enabled.</p>
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Before the player auction, each team buys <strong className="text-white">one PL club</strong> in a random-nomination, single-bid auction.</RuleItem>
          <RuleItem>The club auction shares the same purse as the player auction. <strong className="text-white">One club per team, one owner per club, season-long, non-tradeable.</strong></RuleItem>
          <RuleItem>If no one bids on a nominated club, it goes <strong className="text-white">unsold</strong> and is re-nominated in a round-2 pass before the player auction begins.</RuleItem>
          <RuleItem><strong className="text-white">Synergy multiplier (×1.5):</strong> any owned player whose current PL club matches your owned club earns a <strong>+50% bonus</strong> on their raw GW points. Bonus follows the player&apos;s current PL club — transfers re-route the multiplier.</RuleItem>
          <RuleItem><strong className="text-white">Club result bonus</strong>: every GW your owned club wins or draws a real-PL fixture you earn points based on the club&apos;s tier (per-fixture; DGW = doubled, BGW = 0).</RuleItem>
          <RuleItem>Tier bonuses — <strong className="text-yellow-300">Top 8</strong>: +2 win / +1 draw · <strong className="text-blue-300">Mid</strong>: +3 / +1 · <strong className="text-emerald-300">Promoted</strong>: +4 / +2.</RuleItem>
          <RuleItem>Your team displays as the <strong className="text-white">owned club&apos;s name</strong> all season (e.g. &quot;Liverpool&quot;), with a tier-coloured chip beside it.</RuleItem>
          <RuleItem>Synergy bonuses <strong className="text-white">do not</strong> compound into FMV / squad value / trade economics — those stay on raw points only.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="H" color="green" title="Standings" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Teams are ranked by <strong className="text-white">total cumulative FPL points</strong> scored by their squad across all gameweeks.</RuleItem>
          <RuleItem>For PL Club Auction leagues, total = <strong className="text-white">Raw + Synergy + Club result</strong>.</RuleItem>
          <RuleItem>In case of a tie, teams with a higher average GW score rank higher.</RuleItem>
          <RuleItem>Purse size and trade activity do not affect standings — only on-pitch performance counts.</RuleItem>
        </ul>
      </section>
    </div>
  );
}
