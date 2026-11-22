/**
 * Dashboard W/D/L (Recent Form, Season Stats, Last GW card) is decided by the two scores,
 * never by the stored match points, which are chip-adjusted.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { matchOutcome } from "../../src/lib/match-outcome";

test("higher score is a win", () => {
  assert.equal(matchOutcome(130, 98), "W");
});

test("equal scores are a draw", () => {
  assert.equal(matchOutcome(101, 101), "D");
});

test("lower score is a loss", () => {
  assert.equal(matchOutcome(88, 120), "L");
});

test("a Double Pointer win is still a win even though its stored match points are 4", () => {
  // The result row for this side holds matchPoints = 4; the old `=== 2` check read it as L.
  const stored = { own: 142, opp: 117, matchPoints: 4 };
  assert.equal(matchOutcome(stored.own, stored.opp), "W");
});

test("a Win-Win loss is still a loss even though its stored match points are 2", () => {
  // Win-Win awards 2 league points regardless; the match itself was lost.
  const stored = { own: 90, opp: 112, matchPoints: 2 };
  assert.equal(matchOutcome(stored.own, stored.opp), "L");
});
