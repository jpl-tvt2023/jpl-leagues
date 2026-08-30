/**
 * Which gameweek the fixtures pages open on.
 *
 * The shipped bug: the rule advanced only through *scored* gameweeks and
 * stopped at the first unscored one, so with GW1 scored and GW2 being played
 * the page opened on GW1. First case below is that regression.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { pickDefaultGameweek, type GameweekChoice } from "../../src/lib/gameweeks/default-gw";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-08-30T05:00:00.000Z");

function gw(n: number, deadlineOffsetHours: number, isFullyResolved: boolean): GameweekChoice {
  return { gw: n, deadline: NOW + deadlineOffsetHours * HOUR, isFullyResolved };
}

test("GW1 scored and GW2 under way opens on GW2", () => {
  const choices = [gw(1, -216, true), gw(2, -36, false), gw(3, 132, false)];
  assert.equal(pickDefaultGameweek(choices, NOW), 2);
});

test("current gameweek finished and scored opens on the upcoming one", () => {
  const choices = [gw(1, -216, true), gw(2, -36, true), gw(3, 132, false)];
  assert.equal(pickDefaultGameweek(choices, NOW), 3);
});

test("nothing played yet opens on the first gameweek", () => {
  const choices = [gw(1, 12, false), gw(2, 180, false)];
  assert.equal(pickDefaultGameweek(choices, NOW), 1);
});

test("season over stays on the last gameweek", () => {
  const choices = [gw(37, -360, true), gw(38, -180, true)];
  assert.equal(pickDefaultGameweek(choices, NOW), 38);
});

test("a late-scored earlier gameweek does not pull the selection backwards", () => {
  // GW1 still unscored (admin hasn't processed it) while GW2 is being played.
  // Searching from the back keeps us on the gameweek people are watching.
  const choices = [gw(1, -216, false), gw(2, -36, false), gw(3, 132, false)];
  assert.equal(pickDefaultGameweek(choices, NOW), 2);
});

test("input order does not matter", () => {
  const choices = [gw(3, 132, false), gw(1, -216, true), gw(2, -36, false)];
  assert.equal(pickDefaultGameweek(choices, NOW), 2);
});

test("an empty list selects nothing", () => {
  assert.equal(pickDefaultGameweek([], NOW), null);
});

test("a deadline exactly now counts as passed", () => {
  const choices = [gw(1, 0, false), gw(2, 168, false)];
  assert.equal(pickDefaultGameweek(choices, NOW), 1);
});
