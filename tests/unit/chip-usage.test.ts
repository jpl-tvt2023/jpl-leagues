/**
 * Which chips count as spent in a set.
 *
 * The bug these pin: `teams.<chip>Set<N>Used` was the thing every read and the submission
 * guard consulted, but nothing on the player's path ever set it — so a chip played in an
 * earlier gameweek came back "Available" for ever, and the same chip could be played twice
 * in one set. Usage is derived from the chip rows instead; these fix which rows count.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chipsUsedInSet, chipGameweekInSet, type ChipUsageRow } from "../../src/lib/formats/tvt/chip-usage";

// TVT-16/32 defaults: playoffs from GW31, so Set 1 = GW1-15 and Set 2 = GW16-30.
const PLAYOFF_START = 31;

const row = (over: Partial<ChipUsageRow> = {}): ChipUsageRow => ({
  chipType: "D",
  gameweekNumber: 3,
  isValid: true,
  isProcessed: false,
  ...over,
});

test("a live declaration occupies its set slot", () => {
  const used = chipsUsedInSet([row()], 1, PLAYOFF_START);
  assert.deepEqual([...used], ["D"]);
});

test("the regression: a chip played in a past gameweek stays used", () => {
  // Submitted in GW3 and since scored — exactly the rows a team accumulates over a season,
  // and the case that used to read back as "Available".
  const rows = [row({ gameweekNumber: 3, isValid: true, isProcessed: true })];
  assert.ok(chipsUsedInSet(rows, 1, PLAYOFF_START).has("D"));
});

test("a wasted chip is spent — processed, invalid, paid nothing", () => {
  const rows = [row({ isValid: false, isProcessed: true })];
  assert.ok(chipsUsedInSet(rows, 1, PLAYOFF_START).has("D"));
});

test("a rejected declaration that was never played is NOT spent", () => {
  // invalid AND unprocessed: refused at submission, so the team keeps the chip.
  const rows = [row({ isValid: false, isProcessed: false })];
  assert.equal(chipsUsedInSet(rows, 1, PLAYOFF_START).size, 0);
});

test("sets do not leak into each other", () => {
  const rows = [
    row({ chipType: "D", gameweekNumber: 3 }),   // set 1
    row({ chipType: "W", gameweekNumber: 20 }),  // set 2
  ];
  assert.deepEqual([...chipsUsedInSet(rows, 1, PLAYOFF_START)], ["D"]);
  assert.deepEqual([...chipsUsedInSet(rows, 2, PLAYOFF_START)], ["W"]);
});

test("set boundaries follow the league's playoffStartGw, not a hardcoded 15/30", () => {
  // TVT-8 runs playoffs from GW36, so the midpoint is GW17 and GW16 is still Set 1.
  const rows = [row({ gameweekNumber: 16 })];
  assert.ok(chipsUsedInSet(rows, 1, 36).has("D"), "GW16 is Set 1 when playoffs start at 36");
  assert.equal(chipsUsedInSet(rows, 1, PLAYOFF_START).size, 0, "GW16 is Set 2 when playoffs start at 31");
});

test("playoffs have no chip sets", () => {
  const rows = [row({ gameweekNumber: 33 })];
  assert.equal(chipsUsedInSet(rows, "playoffs", PLAYOFF_START).size, 0);
});

test("all six chip codes are reported, not just D/C/W", () => {
  const rows = ["W", "D", "C", "SL", "CB", "UD"].map((chipType, i) =>
    row({ chipType, gameweekNumber: i + 1 })
  );
  assert.deepEqual([...chipsUsedInSet(rows, 1, PLAYOFF_START)].sort(), ["C", "CB", "D", "SL", "UD", "W"]);
});

test("chipGameweekInSet names the gameweek each chip was spent in", () => {
  const rows = [
    row({ chipType: "D", gameweekNumber: 7 }),
    row({ chipType: "W", gameweekNumber: 2 }),
  ];
  const gws = chipGameweekInSet(rows, 1, PLAYOFF_START);
  assert.equal(gws.get("D"), 7);
  assert.equal(gws.get("W"), 2);
  assert.equal(gws.get("C"), undefined);
});

test("chipGameweekInSet reports the earliest gameweek if a chip somehow has two rows", () => {
  const rows = [
    row({ chipType: "D", gameweekNumber: 9 }),
    row({ chipType: "D", gameweekNumber: 4 }),
  ];
  assert.equal(chipGameweekInSet(rows, 1, PLAYOFF_START).get("D"), 4);
});
