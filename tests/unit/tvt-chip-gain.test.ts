/**
 * League points a TVT chip gained — the figure on the fixtures page's Chips & hits card.
 *
 * It must agree with the standings' CP/BP column, so it reads what the scorer stores — only the
 * EXTRA points a chip earned (gameweek_chips.pointsAwarded): Win-Win 2 minus the natural result,
 * Double Pointer the natural result again (plus the bonus point it doubled), a Challenge its match
 * points, and 0 for anything wasted or voided. A Win-Win on a win is 0 and says why.
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
  const lost = gain({ chipType: "W", settled: true, own: 120, opp: 150 })!;
  assert.equal(lost.points, 2);
  assert.equal(lost.detail, "Lost 120–150. Win-Win raised the result from 0 to 2 league points.");
  assert.equal(lost.note, undefined);
  assert.equal(gain({ chipType: "W", settled: true, own: 150, opp: 150 })!.points, 1);
});

test("Win-Win on a win reads 0, and says the match was won", () => {
  // The scorer stores 0 extra for a win: the win's own 2 points are already in the table.
  const won = gain({ chipType: "W", settled: true, own: 180, opp: 150, pointsAwarded: 0 })!;
  assert.equal(won.points, 0);
  assert.equal(won.provisional, false);
  assert.equal(won.note, "match won");
  assert.equal(won.detail, "Won 180–150. The win had already earned 2 league points, so Win-Win added none.");

  const winning = gain({ chipType: "W", own: 150, opp: 90 })!;
  assert.deepEqual([winning.points, winning.provisional, winning.note], [0, true, "winning"]);
  assert.match(winning.detail, /^Winning 150–90\. A win earns 2 league points on its own/);
});

test("the stored figure is the truth once the chip is processed", () => {
  // Derivation from this scoreline would say 2; the scorer's stored 1 wins.
  assert.equal(gain({ chipType: "W", settled: true, own: 120, opp: 150, pointsAwarded: 1 })!.points, 1);
  // Stored, even with no score on hand.
  const stored = gain({ chipType: "D", pointsAwarded: 2 })!;
  assert.equal(stored.points, 2);
  assert.equal(stored.detail, "2 league points awarded by the chip.");
});

test("Double Pointer: the natural result again, plus the bonus point it doubled", () => {
  const withBonus = gain({ chipType: "D", settled: true, own: 180, opp: 90, pointsAwarded: 2, doubledBonus: true })!;
  assert.equal(withBonus.points, 3);
  assert.equal(
    withBonus.detail,
    "Won 180–90. Double Pointer doubled the match points from 2 to 4. It also doubled the group bonus from 1 to 2.",
  );
  assert.equal(gain({ chipType: "D", settled: true, own: 180, opp: 150 })!.points, 2);
  const lost = gain({ chipType: "D", settled: true, own: 90, opp: 150 })!;
  assert.equal(lost.points, 0);
  assert.equal(lost.detail, "Lost 90–150. With no match points to double, Double Pointer added none.");
});

test("Challenge: its match points, stored or from the scoreline", () => {
  const challenge = (a: number, b: number, pointsAwarded: number | null) => ({
    challengedTeamName: "Dracarys", challengerScore: a, challengedScore: b, pointsAwarded,
  });
  const won = gain({ chipType: "C", challenge: challenge(214, 186, 2) })!;
  assert.deepEqual([won.points, won.provisional], [2, false]);
  assert.equal(won.detail, "Beat Dracarys 214–186 in the challenge.");
  assert.equal(gain({ chipType: "C", challenge: challenge(200, 200, 1) })!.points, 1);
  assert.equal(gain({ chipType: "C", challenge: challenge(150, 186, 0) })!.points, 0);

  const live = gain({ chipType: "C", challenge: challenge(150, 120, null) })!;
  assert.deepEqual([live.points, live.provisional], [2, true]);
  assert.equal(live.detail, "Leading Dracarys 150–120 in the challenge. Provisional until the gameweek is scored.");
  assert.equal(gain({ chipType: "C" }), null, "no challenge rebuilt and nothing stored");
});

test("a wasted chip gained nothing, whatever the scoreline", () => {
  const wasted = gain({ chipType: "W", isWasted: true, wastedReason: "Bench Boost 1 played the same gameweek", settled: true, own: 90, opp: 150 })!;
  assert.equal(wasted.points, 0);
  assert.equal(wasted.detail, "Bench Boost 1 played the same gameweek");
  assert.equal(gain({ chipType: "D", isWasted: true })!.detail, "Wasted. No chip points were awarded.");
});

test("live Win-Win: void with any hit, wasted on a predicted clash, else 2 minus the result", () => {
  const voided = gain({ chipType: "W", own: 90, opp: 150, hits: 4 })!;
  assert.deepEqual([voided.points, voided.provisional], [0, true]);
  assert.match(voided.detail, /^Void: the team has taken 4 points of transfer hits/);

  const clash = gain({ chipType: "W", own: 90, opp: 150, predictedWasteReason: "Triple Captain 1 played the same gameweek" })!;
  assert.equal(clash.points, 0);
  assert.equal(clash.detail, "May be wasted: Triple Captain 1 played the same gameweek. Provisional until the gameweek is scored.");

  const losing = gain({ chipType: "W", own: 90, opp: 150 })!;
  assert.deepEqual([losing.points, losing.provisional], [2, true]);
  assert.equal(losing.detail, "Losing 90–150. Win-Win would raise the result from 0 to 2 league points. Provisional until the gameweek is scored.");
});

test("live Double Pointer counts no bonus — that is decided across the group when scored", () => {
  assert.equal(gain({ chipType: "D", own: 250, opp: 90 })!.points, 2);
});

test("nothing to go on yet: no score and nothing stored", () => {
  assert.equal(gain({ chipType: "W" }), null);
  assert.equal(gain({ chipType: "D", settled: true }), null);
  assert.equal(gain({ chipType: "X", own: 1, opp: 0 }), null, "unknown chip");
});
