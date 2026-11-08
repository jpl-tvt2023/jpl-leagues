/**
 * JPL Auction — release refunds and deadwood.
 *
 * Refund = rate × purchase price + 100% of the FMV gain (FMV − purchase price), where the rate is
 * 50% for a standard release and 80% for a deadwood one. So a team always keeps every pound the
 * player appreciated while it owned him, and loses part of what it paid — less of it for deadwood.
 *
 * A player is deadwood when, at the moment his team marks him for release, either:
 *   - he played 0 minutes in each of his club's last 5 finished games, or
 *   - FPL lists him as unavailable (status "u": transferred out, loaned out, left the club), or he
 *     has dropped out of FPL's player list altogether.
 *
 * The refund and the classification are snapshotted when the release is marked (with the FMV used,
 * so the breakdown can be shown again later), and credited when the release finalizes.
 *
 * Zero imports on purpose (same reasoning as cycle.ts) so this unit-tests without a DB or FPL and
 * can be called from client components.
 */

/** How many of the player's most recent finished games he must have sat out entirely. */
export const DEADWOOD_GAMES_WINDOW = 5;
export const STANDARD_RATE = 0.5;
export const DEADWOOD_RATE = 0.8;

/**
 * Why a release was priced as deadwood. Stored on `auction_ownership.deadwood_reason`;
 * null there means a standard release.
 */
export type DeadwoodReason = "no_minutes" | "unavailable";

export interface FinishedGame {
  kickoffTime: string | null;
  minutes: number;
}

export interface RefundBreakdown {
  purchasePrice: number;
  fmv: number;
  deadwoodReason: DeadwoodReason | null;
  /** 0.5 standard, 0.8 deadwood. */
  rate: number;
  /** floor(rate × purchase price). */
  base: number;
  /** FMV − purchase price, refunded in full. */
  gain: number;
  /** base + gain — what the team is credited. */
  refund: number;
  /** The part of the purchase price not coming back (never negative). */
  forfeit: number;
}

/**
 * Classify a player at release time.
 *
 * @param fplStatus - FPL bootstrap status, or null when the player is no longer in FPL's list.
 * @param finishedGames - The player's finished games this season, in any order.
 */
export function classifyDeadwood(
  fplStatus: string | null,
  finishedGames: FinishedGame[]
): DeadwoodReason | null {
  if (fplStatus === null || fplStatus === "u") return "unavailable";
  const lastGames = lastFinishedGames(finishedGames);
  // Fewer than 5 games on record (early season, or a recent signing) isn't enough to call it.
  if (lastGames.length < DEADWOOD_GAMES_WINDOW) return null;
  return lastGames.every((g) => g.minutes === 0) ? "no_minutes" : null;
}

/** The player's most recent DEADWOOD_GAMES_WINDOW finished games, newest first. */
export function lastFinishedGames<T extends FinishedGame>(finishedGames: T[]): T[] {
  return [...finishedGames]
    .sort((a, b) => (b.kickoffTime ?? "").localeCompare(a.kickoffTime ?? ""))
    .slice(0, DEADWOOD_GAMES_WINDOW);
}

/** Price a release. Every display of a refund should come from one of these. */
export function priceReleaseRefund(
  purchasePrice: number,
  fmv: number,
  deadwoodReason: DeadwoodReason | null
): RefundBreakdown {
  const rate = deadwoodReason ? DEADWOOD_RATE : STANDARD_RATE;
  const base = Math.floor(purchasePrice * rate);
  const gain = fmv - purchasePrice;
  const refund = base + gain;
  return { purchasePrice, fmv, deadwoodReason, rate, base, gain, refund, forfeit: Math.max(0, purchasePrice - refund) };
}

/**
 * Rebuild the breakdown of an already-marked release from its snapshot. Null for rows priced
 * before the FMV was snapshotted (old 50%-rule releases) — show their amount only.
 */
export function breakdownFromSnapshot(o: {
  purchasePrice: number;
  releaseFmv: number | null;
  releaseRefund: number | null;
  deadwoodReason: string | null;
}): RefundBreakdown | null {
  if (o.releaseFmv == null || o.releaseRefund == null) return null;
  const b = priceReleaseRefund(o.purchasePrice, o.releaseFmv, parseDeadwoodReason(o.deadwoodReason));
  // A mismatch means the row wasn't priced by this formula; don't print a sum that doesn't add up.
  return b.refund === o.releaseRefund ? b : null;
}

/** "80% of £10.0M + £2.8M FMV gain = £10.8M" — for ledger lines, tooltips and notifications. */
export function formatRefundBreakdown(b: RefundBreakdown): string {
  const pct = `${Math.round(b.rate * 100)}%`;
  const gain =
    b.gain > 0 ? ` + ${formatMoney(b.gain)} FMV gain` : b.gain < 0 ? ` − ${formatMoney(-b.gain)} FMV loss` : "";
  return `${pct} of ${formatMoney(b.purchasePrice)}${gain} = ${formatMoney(b.refund)}`;
}

/**
 * When pending releases get confirmed (refund credited, player leaves the squad) — the one sentence
 * every screen uses. `nextReleaseGw` is the next release gameweek still to be scored, if any.
 */
export function describeReleaseConfirmation(nextReleaseGw: number | null): string {
  return nextReleaseGw != null
    ? `Confirmed at the end of GW${nextReleaseGw} scoring, or once the mini-auction starts — whichever comes first.`
    : "Confirmed once the next mini-auction starts.";
}

/** Short user-facing explanation of a deadwood verdict. */
export function describeDeadwoodReason(reason: DeadwoodReason): string {
  return reason === "unavailable"
    ? "unavailable in FPL — transferred or loaned out"
    : `no minutes in his last ${DEADWOOD_GAMES_WINDOW} games`;
}

/** Narrow an untyped DB/API value to a DeadwoodReason. */
export function parseDeadwoodReason(raw: string | null | undefined): DeadwoodReason | null {
  return raw === "no_minutes" || raw === "unavailable" ? raw : null;
}

/** £12.80M / £450K — the compact style the auction pages use. */
export function formatMoney(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}
