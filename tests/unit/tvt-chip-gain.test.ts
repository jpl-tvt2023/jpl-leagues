/**
 * League points a TVT chip gained — the figure on the fixtures page's Chips & hits card.
 *
 * It must agree with the scorer, which stores only the EXTRA points a chip earned
 * (gameweek_chips.pointsAwarded), so these pin the same arithmetic: Win-Win 2 minus the natural
 * result, Double Pointer the natural result again (plus the bonus point it doubled), a Challenge
 * its match points, and 0 for anything wasted or voided.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { tvtChipGain, type TvtChipGainInput } from "../../src/lib/formats/tvt/chip-gain";

function gain(over: Partial<TvtChipGainInput> & { chipType: string }) {
  return tvtChipGain({ isWasted: false, own: null, opp: null, settled: false, ...over });
}

test("Win-Win, scored: lost +2, drew +1, won 0", () => {
  assert.equal(gain({ chipType: "W", settled: true, own: 120, opp: 150 })!.points, 2);
  assert.equal(gain({ chipType: "W", settled: true, own: 150, opp: 150 })!.points, 1);
  const won = gain({ chipType: "W", settled: true, own: 180, opp: 150 })!;
  assert.equal(won.points, 0);
  assert.equal(won.provisional, false);
  assert.match(won.detail, /Won 180–150/);
});

test("the stored figure is the truth once the chip is processed", () => {
  // Derivation from this scoreline would say 2; the scorer's stored 1 wins.
  assert.equal(gain({ chipType: "W", settled: true, own: 120, opp: 150, pointsAwarded: 1 })!.points, 1);
  // Stored, even with no score on hand.
  assert.equal(gain({ chipType: "W", pointsAwarded: 2 })!.points, 2);
});

test("Double Pointer: the natural result again, plus the bonus point it doubled", () => {
  const withBonus = gain({ chipType: "D", settled: true, own: 180, opp: 90, pointsAwarded: 2, doubledBonus: true })!;
  assert.equal(withBonus.points, 3);
  assert.match(withBonus.detail, /bonus 1 → 2/);
  assert.equal(gain({ chipType: "D", settled: true, own: 180, opp: 150 })!.points, 2);
  assert.equal(gain({ chipType: "D", settled: true, own: 90, opp: 150 })!.points, 0);
});

test("Challenge: its match points, stored or from the scoreline", () => {
  const challenge = (a: number, b: number, pointsAwarded: number | null) => ({
    challengedTeamName: "Dracarys", challengerScore: a, challengedScore: b, pointsAwarded,
  });
  const won = gain({ chipType: "C", challenge: challenge(214, 186, 2) })!;
  assert.deepEqual([won.points, won.provisional], [2, false]);
  assert.equal(won.detail, "Beat Dracarys 214–186");
  assert.equal(gain({ chipType: "C", challenge: challenge(200, 200, 1) })!.points, 1);
  assert.equal(gain({ chipType: "C", challenge: challenge(150, 186, 0) })!.points, 0);

  const live = gain({ chipType: "C", challenge: challenge(150, 120, null) })!;
  assert.deepEqual([live.points, live.provisional], [2, true]);
  assert.equal(gain({ chipType: "C" }), null, "no challenge rebuilt and nothing stored");
});

test("a wasted chip gained nothing, whatever the scoreline", () => {
  const wasted = gain({ chipType: "W", isWasted: true, wastedReason: "Bench Boost 1 played the same gameweek", settled: true, own: 90, opp: 150 })!;
  assert.equal(wasted.points, 0);
  assert.equal(wasted.detail, "Bench Boost 1 played the same gameweek");
});

test("live Win-Win: void with any hit, wasted on a predicted clash, else 2 minus the result", () => {
  const voided = gain({ chipType: "W", own: 90, opp: 150, hits: 4 })!;
  assert.deepEqual([voided.points, voided.provisional], [0, true]);
  assert.match(voided.detail, /^Void/);

  const clash = gain({ chipType: "W", own: 90, opp: 150, predictedWasteReason: "Triple Captain 1 played the same gameweek" })!;
  assert.equal(clash.points, 0);
  assert.match(clash.detail, /^May be wasted/);

  const losing = gain({ chipType: "W", own: 90, opp: 150 })!;
  assert.deepEqual([losing.points, losing.provisional], [2, true]);
  assert.match(losing.detail, /provisional/);
});

test("live Double Pointer counts no bonus — that is decided across the group when scored", () => {
  assert.equal(gain({ chipType: "D", own: 250, opp: 90 })!.points, 2);
});

test("nothing to go on yet: no score and nothing stored", () => {
  assert.equal(gain({ chipType: "W" }), null);
  assert.equal(gain({ chipType: "D", settled: true }), null);
  assert.equal(gain({ chipType: "X", own: 1, opp: 0 }), null, "unknown chip");
});
