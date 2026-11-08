/**
 * JPL Auction release refunds + deadwood.
 *
 * Refund = rate × purchase price + 100% of (FMV − purchase price); rate is 50%, or 80% when the
 * player is deadwood: 0 minutes in each of his last 5 finished games, or FPL status "u" / no longer
 * listed by FPL.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEADWOOD_GAMES_WINDOW,
  breakdownFromSnapshot,
  classifyDeadwood,
  formatRefundBreakdown,
  lastFinishedGames,
  parseDeadwoodReason,
  priceReleaseRefund,
  type FinishedGame,
} from "../../src/lib/formats/auction/release-refund";

/** Games on consecutive days, oldest first, with the given minutes. */
function games(...minutes: number[]): FinishedGame[] {
  return minutes.map((m, i) => ({
    kickoffTime: new Date(Date.UTC(2026, 7, 15 + i, 14)).toISOString(),
    minutes: m,
  }));
}

/* ── classifyDeadwood ───────────────────────────────────────────────────── */

test("the window is 5 games", () => {
  assert.equal(DEADWOOD_GAMES_WINDOW, 5);
});

test("0 minutes in each of the last 5 games is deadwood", () => {
  assert.equal(classifyDeadwood("a", games(0, 0, 0, 0, 0)), "no_minutes");
});

test("earlier minutes don't matter once the last 5 are all 0", () => {
  assert.equal(classifyDeadwood("i", games(90, 90, 45, 0, 0, 0, 0, 0)), "no_minutes");
});

test("a single minute in the last 5 games is not deadwood", () => {
  assert.equal(classifyDeadwood("a", games(0, 0, 1, 0, 0)), null);
  assert.equal(classifyDeadwood("i", games(0, 0, 0, 0, 0, 12)), null);
});

test("the most recent games are picked by kickoff, not array order", () => {
  // Played 90 in the latest game, but the array lists it first.
  const newestFirst = games(0, 0, 0, 0, 0, 90).reverse();
  assert.equal(classifyDeadwood("a", newestFirst), null);
  assert.deepEqual(lastFinishedGames(newestFirst).map((g) => g.minutes), [90, 0, 0, 0, 0]);
});

test("fewer than 5 finished games is never deadwood on minutes alone", () => {
  assert.equal(classifyDeadwood("a", games(0, 0, 0, 0)), null);
  assert.equal(classifyDeadwood("i", []), null);
});

test("FPL status 'u' (transferred / loaned out) is deadwood regardless of minutes", () => {
  assert.equal(classifyDeadwood("u", games(90, 90, 90, 90, 90)), "unavailable");
  assert.equal(classifyDeadwood("u", []), "unavailable");
});

test("a player missing from FPL's list is deadwood", () => {
  assert.equal(classifyDeadwood(null, []), "unavailable");
});

test("injured, suspended or doubtful players are judged on minutes, not status", () => {
  for (const status of ["i", "s", "d", "n"]) {
    assert.equal(classifyDeadwood(status, games(90, 0, 0, 0, 0, 0)), "no_minutes", `status ${status}`);
    assert.equal(classifyDeadwood(status, games(0, 0, 0, 0, 30)), null, `status ${status}`);
  }
});

/* ── priceReleaseRefund ─────────────────────────────────────────────────── */

test("worked example: £10M player at £12.8M FMV", () => {
  const standard = priceReleaseRefund(10_000_000, 12_800_000, null);
  assert.deepEqual(
    { rate: standard.rate, base: standard.base, gain: standard.gain, refund: standard.refund, forfeit: standard.forfeit },
    { rate: 0.5, base: 5_000_000, gain: 2_800_000, refund: 7_800_000, forfeit: 2_200_000 }
  );

  const deadwood = priceReleaseRefund(10_000_000, 12_800_000, "no_minutes");
  assert.deepEqual(
    { rate: deadwood.rate, base: deadwood.base, gain: deadwood.gain, refund: deadwood.refund, forfeit: deadwood.forfeit },
    { rate: 0.8, base: 8_000_000, gain: 2_800_000, refund: 10_800_000, forfeit: 0 }
  );
});

test("no FMV gain: the refund is just the rate × purchase price", () => {
  assert.equal(priceReleaseRefund(7_500_000, 7_500_000, null).refund, 3_750_000);
  assert.equal(priceReleaseRefund(7_500_000, 7_500_000, "unavailable").refund, 6_000_000);
});

test("the rate × purchase part is floored; the gain is added whole", () => {
  const b = priceReleaseRefund(1_000_001, 1_020_001, null);
  assert.equal(b.base, 500_000);
  assert.equal(b.gain, 20_000);
  assert.equal(b.refund, 520_000);
});

test("forfeit is never negative when the refund exceeds what was paid", () => {
  const b = priceReleaseRefund(1_000_000, 5_000_000, null);
  assert.equal(b.refund, 4_500_000);
  assert.equal(b.forfeit, 0);
});

/* ── formatRefundBreakdown / breakdownFromSnapshot ──────────────────────── */

test("formatRefundBreakdown reads as the sum it is", () => {
  assert.equal(
    formatRefundBreakdown(priceReleaseRefund(10_000_000, 12_800_000, "no_minutes")),
    "80% of £10.00M + £2.80M FMV gain = £10.80M"
  );
  assert.equal(formatRefundBreakdown(priceReleaseRefund(10_000_000, 10_000_000, null)), "50% of £10.00M = £5.00M");
});

test("breakdownFromSnapshot rebuilds a current-rule snapshot", () => {
  const b = breakdownFromSnapshot({
    purchasePrice: 10_000_000,
    releaseFmv: 12_800_000,
    releaseRefund: 10_800_000,
    deadwoodReason: "no_minutes",
  });
  assert.equal(b?.refund, 10_800_000);
  assert.equal(b?.deadwoodReason, "no_minutes");
});

test("breakdownFromSnapshot returns null for old-rule or legacy rows", () => {
  // Old rule: 50% of FMV, no FMV snapshot.
  assert.equal(
    breakdownFromSnapshot({ purchasePrice: 10_000_000, releaseFmv: null, releaseRefund: 6_400_000, deadwoodReason: null }),
    null
  );
  // Legacy: nothing snapshotted.
  assert.equal(
    breakdownFromSnapshot({ purchasePrice: 10_000_000, releaseFmv: null, releaseRefund: null, deadwoodReason: null }),
    null
  );
  // A refund that doesn't match the formula is not explained with a sum that doesn't add up.
  assert.equal(
    breakdownFromSnapshot({ purchasePrice: 10_000_000, releaseFmv: 12_800_000, releaseRefund: 6_400_000, deadwoodReason: null }),
    null
  );
});

test("parseDeadwoodReason accepts only the stored values", () => {
  assert.equal(parseDeadwoodReason("no_minutes"), "no_minutes");
  assert.equal(parseDeadwoodReason("unavailable"), "unavailable");
  assert.equal(parseDeadwoodReason(null), null);
  assert.equal(parseDeadwoodReason(undefined), null);
  assert.equal(parseDeadwoodReason("deadwood"), null);
});
