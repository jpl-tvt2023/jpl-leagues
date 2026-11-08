"use client";

import { GW_PAYOUTS, MINIMUM_FLOOR_PAYOUT } from "@/lib/formats/auction/economy";
import { DEFAULT_RELEASE_CYCLE_GWS, formatReleaseCycleGws } from "@/lib/formats/auction/cycle";
import { RELEASE_DEADLINE_HOURS } from "@/lib/formats/auction/release-deadline";
import {
  DEADWOOD_GAMES_WINDOW,
  DEADWOOD_RATE,
  STANDARD_RATE,
  formatMoney,
  formatRefundBreakdown,
  priceReleaseRefund,
} from "@/lib/formats/auction/release-refund";
import { ABSOLUTE_SQUAD_CAP, MAX_SQUAD_SIZE } from "@/lib/formats/auction/squad-rules";
import { RuleItem, SectionHeader, formatPayout } from "./shared";

/** Worked example for the release rules — computed, so it can't drift from the real formula. */
const EXAMPLE = { purchasePrice: 10_000_000, fmv: 12_800_000 };

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function AuctionRules({
  tier = "complete",
  releaseCycleGws = DEFAULT_RELEASE_CYCLE_GWS,
}: {
  tier?: "primary" | "complete";
  /** The league's planned mini-auction gameweeks, so the rules name the real ones. */
  releaseCycleGws?: number[];
}) {
  // Primary tier disables trades and slot 16/17/18 expansion — hide those rules so they aren't
  // shown for a feature the league can't use.
  const primary = tier === "primary";
  const miniAuctionGws = formatReleaseCycleGws(releaseCycleGws);
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="A" color="green" title="Budget & Purse" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Each manager starts with an <strong className="text-white">initial budget</strong> (purse) set by the league.</RuleItem>
          <RuleItem>Your purse increases via GW payouts{primary ? " and release refunds." : ", release refunds, and trade income."}</RuleItem>
          <RuleItem>Your purse decreases via player purchases{primary ? " and penalty-slot redemptions." : ", penalty-slot redemptions, bonus-slot unlocks, and trade payments."}</RuleItem>
          <RuleItem>The purse is the currency of the league — manage it wisely across {primary ? "auctions" : "auctions and trades"}.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="B" color="purple" title="Auction Sessions" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>The <strong className="text-white">Initial Auction</strong> fills all squads before the season begins. Teams nominate players in snake-draft order.</RuleItem>
          <RuleItem><strong className="text-white">Mini-Auctions</strong> occur at designated points during the season, around <strong className="text-white">{miniAuctionGws}</strong>. Pending releases are confirmed {RELEASE_DEADLINE_HOURS} hours before each one starts, so every released player is back in the pool a day before bidding opens.</RuleItem>
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
          <RuleItem>
            {primary
              ? `Effective max squad size = ${MAX_SQUAD_SIZE} (base) − penalty slots.`
              : `Effective max squad size = ${MAX_SQUAD_SIZE} (base) + unlocked bonus slots − penalty slots. Absolute ceiling is ${ABSOLUTE_SQUAD_CAP}.`}
          </RuleItem>
          <RuleItem>No FPL player can be owned by more than one team in the same league simultaneously.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter="D" color="blue" title="Scoring & Payouts" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Each gameweek, your squad score is the <strong className="text-white">sum of all active FPL points</strong> earned by your owned players.</RuleItem>
          <RuleItem>Teams are <strong className="text-white">ranked each GW</strong> by their squad score. Top-ranked teams earn the highest payouts.</RuleItem>
          <RuleItem>Payout amounts are credited to your purse at the end of each gameweek.</RuleItem>
          <RuleItem><strong className="text-white">Ties split the pot.</strong> Teams level on GW points <strong className="text-white">share the same rank</strong> and each receive the <strong className="text-white">average</strong> of the payouts for the places they occupy — e.g. two teams tied at the top take {formatPayout(Math.floor((GW_PAYOUTS[1] + GW_PAYOUTS[2]) / 2))} each, and the next team is ranked #3.</RuleItem>
          <RuleItem>The <strong className="text-white">overall standings</strong> are determined by cumulative total FPL points scored across all gameweeks.</RuleItem>
        </ul>

        {/* Payout schedule applies to both tiers — Primary earns GW payouts too. */}
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
        {/* Letters shift up one when the Trades section (E) is hidden, so Primary reads A–G. */}
        <SectionHeader letter={primary ? "E" : "F"} color="red" title="Player Releases" />
        <div className="mb-5 rounded-xl border border-orange-500/40 bg-orange-500/10 p-4 text-sm sm:text-base text-gray-200">
          <p className="font-bold text-white mb-2">When is my release confirmed?</p>
          <p className="mb-2">
            At the <strong className="text-white">release deadline: {RELEASE_DEADLINE_HOURS} hours before the next mini-auction is scheduled to start</strong>.
            The refund is credited to your purse and the player leaves your squad, so everyone can see the final list of available players a day before bidding opens.
            The squad page, Marketplace and dashboard count down to it. While no mini-auction is scheduled, they show the next gameweek deadline as a <strong className="text-white">tentative</strong> date — nothing is confirmed then.
          </p>
          <p>
            You can mark releases and <strong className="text-white">cancel them any time until the deadline</strong>. From the deadline until the mini-auction is over, releases are closed.
            If a mini-auction starts before its deadline, or without a scheduled time, pending releases are confirmed as it starts.
          </p>
        </div>
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>You can <strong className="text-white">request a release</strong> for any active player from your squad page.</RuleItem>
          <RuleItem>The player keeps scoring for your team up to and including the gameweek his release is confirmed in.</RuleItem>
          <RuleItem>
            <strong className="text-white">Refund = {pct(STANDARD_RATE)} of the purchase price + 100% of the FMV gain</strong> (FMV − purchase price). You always keep everything the player appreciated while you owned him; the other half of what you paid is forfeited.
          </RuleItem>
          <RuleItem>
            <strong className="text-yellow-400">Deadwood players get {pct(DEADWOOD_RATE)} instead of {pct(STANDARD_RATE)}.</strong> A player is deadwood if, when you mark him for release, he has played <strong className="text-white">no minutes in his last {DEADWOOD_GAMES_WINDOW} games</strong>, or FPL lists him as <strong className="text-white">unavailable</strong> (transferred out, loaned out or otherwise left).
          </RuleItem>
          <RuleItem>
            Example — bought for {formatMoney(EXAMPLE.purchasePrice)}, FMV now {formatMoney(EXAMPLE.fmv)}: a standard release refunds {formatRefundBreakdown(priceReleaseRefund(EXAMPLE.purchasePrice, EXAMPLE.fmv, null))}; as deadwood, {formatRefundBreakdown(priceReleaseRefund(EXAMPLE.purchasePrice, EXAMPLE.fmv, "no_minutes"))}.
          </RuleItem>
          <RuleItem>On the squad page, <strong className="text-white">Check release amount</strong> shows the exact refund and how it&apos;s worked out without releasing anyone. <strong className="text-white">Release player</strong> shows the same breakdown and asks you to confirm. The amount — and whether the player counts as deadwood — is <strong className="text-white">locked in when you mark the release</strong>.</RuleItem>
          <RuleItem>Released players re-enter the player pool and are available in the next mini-auction.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter={primary ? "F" : "G"} color="green" title="PL Club Ownership (opt-in)" />
        <p className="text-xs text-gray-500 mb-3">Only applies to leagues with the PL Club Auction enabled.</p>
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Before the player auction, each club-less team takes a turn <strong className="text-white">nominating one PL club</strong> it chooses, in a randomized turn order.</RuleItem>
          <RuleItem>The club auction shares the same purse as the player auction. <strong className="text-white">One club per team, one owner per club, season-long, non-tradeable.</strong></RuleItem>
          <RuleItem>The nominating team opens as the bidder; a nominated club <strong className="text-white">always sells</strong> — to the nominator or a higher bid from another club-less team. If a team's nomination timer expires, the system auto-picks an available club on their behalf.</RuleItem>
          <RuleItem><strong className="text-white">Synergy multiplier (×1.5):</strong> any owned player whose current PL club matches your owned club earns a <strong>+50% bonus</strong> on their raw GW points. Bonus follows the player&apos;s current PL club — transfers re-route the multiplier.</RuleItem>
          <RuleItem><strong className="text-white">Club result bonus</strong>: every GW your owned club wins or draws a real-PL fixture you earn points based on the club&apos;s tier (per-fixture; DGW = doubled, BGW = 0).</RuleItem>
          <RuleItem>Tier bonuses — <strong className="text-yellow-300">Top 8</strong>: +4 win / +2 draw · <strong className="text-blue-300">Mid</strong>: +6 / +3 · <strong className="text-emerald-300">Promoted</strong>: +8 / +4.</RuleItem>
          <RuleItem>Your team displays as the <strong className="text-white">owned club&apos;s name</strong> all season (e.g. &quot;Liverpool&quot;), with a tier-coloured chip beside it.</RuleItem>
          <RuleItem>Synergy bonuses <strong className="text-white">do not</strong> compound into {primary ? "FMV / squad value" : "FMV / squad value / trade economics"} — those stay on raw points only.</RuleItem>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-8 backdrop-blur">
        <SectionHeader letter={primary ? "G" : "H"} color="green" title="Standings" />
        <ul className="space-y-3 text-gray-300 text-sm sm:text-base">
          <RuleItem>Teams are ranked by <strong className="text-white">total cumulative FPL points</strong> scored by their squad across all gameweeks.</RuleItem>
          <RuleItem>For PL Club Auction leagues, total = <strong className="text-white">Raw + Synergy + Club result</strong>.</RuleItem>
          <RuleItem>In case of a tie, teams with a higher average GW score rank higher.</RuleItem>
          <RuleItem>{primary ? "Purse size does not" : "Purse size and trade activity do not"} affect standings — only on-pitch performance counts.</RuleItem>
        </ul>
      </section>
    </div>
  );
}
