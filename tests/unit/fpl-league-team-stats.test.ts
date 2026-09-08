/**
 * FPL League page — team chip slots, and the disclosure rule that guards them.
 *
 * /api/fpl-league is PUBLIC. A `gameweek_chips` row exists from the moment a chip is
 * declared, well before its deadline, so the rule "not until the deadline has passed" is the
 * only thing standing between this page and telling the league what a team is about to play.
 * That rule is what the first two tests below pin; everything else is the slot grid around it.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  computeTeamChipSlots,
  type DisclosableChipInput,
} from "../../src/lib/fpl-league/team-chip-slots";
import { computeCaptainCap } from "../../src/lib/captains";

const NOW = Date.UTC(2026, 0, 15); // fixed clock — these tests must not drift with wall time
const HOUR = 3_600_000;

const ENABLED = ["D", "W", "C"];
const PLAYOFF_START = 31; // Set 1 = GW1-15, Set 2 = GW16-30

/** A played, valid, processed chip unless overridden. Deadline defaults to the past. */
function chip(over: Partial<DisclosableChipInput> = {}): DisclosableChipInput {
  return {
    chipType: "D",
    gameweekNumber: 5,
    deadlineMs: NOW - 24 * HOUR,
    isValid: true,
    isProcessed: true,
    hadNegativeHits: false,
    wastedReason: null,
    ...over,
  };
}

const slotFor = (rows: DisclosableChipInput[], code: string, set: 1 | 2) =>
  computeTeamChipSlots(rows, ENABLED, PLAYOFF_START, NOW).find(
    (s) => s.code === code && s.set === set,
  )!;

/* ── the disclosure rule ─────────────────────────────────────────────────── */

test("a chip declared for a gameweek whose deadline has NOT passed stays hidden", () => {
  const slot = slotFor([chip({ gameweekNumber: 6, deadlineMs: NOW + HOUR, isProcessed: false })], "D", 1);
  assert.equal(slot.used, false, "an undeclared-to-the-league chip must not read as spent");
  assert.equal(slot.gw, null, "and it must not name the gameweek it is queued for");
});

test("the same chip becomes visible once its deadline has passed", () => {
  const slot = slotFor([chip({ gameweekNumber: 6, deadlineMs: NOW - HOUR, isProcessed: false })], "D", 1);
  assert.equal(slot.used, true);
  assert.equal(slot.gw, 6);
});

test("a rejected declaration never shows, even long after its deadline", () => {
  // isValid false AND never processed: submitted, refused, never played. Showing it would
  // tell the league a team spent something it did not.
  const slot = slotFor([chip({ isValid: false, isProcessed: false })], "D", 1);
  assert.equal(slot.used, false);
  assert.equal(slot.gw, null);
});

/* ── waste ───────────────────────────────────────────────────────────────── */

test("a processed-but-invalid chip is spent and wasted", () => {
  const slot = slotFor([chip({ isValid: false, isProcessed: true })], "D", 1);
  assert.equal(slot.used, true, "a wasted chip is still spent — it just paid nothing");
  assert.equal(slot.wasted, true);
});

test("wastedReason marks waste even on a valid, processed chip", () => {
  const slot = slotFor([chip({ wastedReason: "opponent blanked" })], "D", 1);
  assert.equal(slot.used, true);
  assert.equal(slot.wasted, true);
});

test("hadNegativeHits marks waste", () => {
  assert.equal(slotFor([chip({ hadNegativeHits: true })], "D", 1).wasted, true);
});

test("an ordinary played chip is not wasted", () => {
  const slot = slotFor([chip()], "D", 1);
  assert.equal(slot.used, true);
  assert.equal(slot.wasted, false);
});

/* ── set boundaries ──────────────────────────────────────────────────────── */

test("set boundaries follow playoffStartGw, not a hardcoded midpoint", () => {
  // playoffStartGw 31 -> midpoint 15
  assert.equal(slotFor([chip({ gameweekNumber: 15 })], "D", 1).used, true);
  assert.equal(slotFor([chip({ gameweekNumber: 15 })], "D", 2).used, false);
  assert.equal(slotFor([chip({ gameweekNumber: 16 })], "D", 2).used, true);

  // playoffStartGw 36 (8-team) -> midpoint 18, so Set 1 runs GW1-18. NOT GW1-17: chip-set.ts's
  // own docstring says 17, and it is wrong — tests/unit/chip-usage.test.ts:115-123 already pins
  // the real boundary. Asserted again here only to prove the slot grid threads playoffStartGw
  // through rather than assuming 31.
  const at36 = (gw: number, set: 1 | 2) =>
    computeTeamChipSlots([chip({ gameweekNumber: gw })], ENABLED, 36, NOW).find(
      (s) => s.code === "D" && s.set === set,
    )!.used;
  assert.equal(at36(18, 1), true);
  assert.equal(at36(19, 2), true);
  assert.equal(at36(19, 1), false);
});

test("a playoff-gameweek chip lands in neither set", () => {
  const rows = [chip({ gameweekNumber: 32 })];
  assert.equal(slotFor(rows, "D", 1).used, false);
  assert.equal(slotFor(rows, "D", 2).used, false);
});

/* ── duplicates ──────────────────────────────────────────────────────────── */

test("duplicate plays in one set report the EARLIEST gameweek, and that row's waste flag", () => {
  // If the waste flag came from a different row than `gw`, the badge would contradict the
  // gameweek printed beside it.
  const rows = [
    chip({ gameweekNumber: 9, wastedReason: "late" }),
    chip({ gameweekNumber: 4 }),
  ];
  const slot = slotFor(rows, "D", 1);
  assert.equal(slot.gw, 4);
  assert.equal(slot.wasted, false, "GW4 is the reported row, and GW4 was not wasted");
});

test("a chip played in BOTH sets reports each set's own gameweek", () => {
  const rows = [chip({ gameweekNumber: 3 }), chip({ gameweekNumber: 20 })];
  assert.equal(slotFor(rows, "D", 1).gw, 3);
  assert.equal(slotFor(rows, "D", 2).gw, 20);
});

/* ── the grid itself ─────────────────────────────────────────────────────── */

test("the grid is one slot per enabled chip per set, and never renders a raw stored code", () => {
  const slots = computeTeamChipSlots([], ENABLED, PLAYOFF_START, NOW);
  assert.equal(slots.length, ENABLED.length * 2);

  const dp = slots.find((s) => s.code === "D" && s.set === 1)!;
  assert.equal(dp.displayCode, "DP", "the DB holds 'D'; the UI shows 'DP'");
  assert.equal(dp.label, "Double Pointer");
  assert.equal(slots.find((s) => s.code === "W")!.displayCode, "WW");
  assert.equal(slots.find((s) => s.code === "C")!.displayCode, "CC");

  assert.ok(slots.every((s) => !s.used && s.gw === null && !s.wasted), "no rows means nothing spent");
});

test("a league on the unimplemented codes still gets its own six slots", () => {
  // enabledChips is honoured as-is rather than filtered to IMPLEMENTED_TVT_CHIPS, so this page
  // and the standings CP/BP tooltip agree about which slots exist.
  const slots = computeTeamChipSlots([], ["SL", "CB", "UD"], PLAYOFF_START, NOW);
  assert.equal(slots.length, 6);
  assert.deepEqual([...new Set(slots.map((s) => s.displayCode))].sort(), ["CB", "SL", "UD"]);
});

test("one chip being spent leaves the others in its set available", () => {
  const slots = computeTeamChipSlots([chip({ chipType: "W", gameweekNumber: 4 })], ENABLED, PLAYOFF_START, NOW);
  assert.equal(slots.find((s) => s.code === "W" && s.set === 1)!.used, true);
  assert.equal(slots.find((s) => s.code === "D" && s.set === 1)!.used, false);
  assert.equal(slots.find((s) => s.code === "W" && s.set === 2)!.used, false);
});

/* ── the captain cap the header row prints ───────────────────────────────── */

test("captain cap is 15 for a default TVT league and 19 for Continental Championship", () => {
  assert.equal(computeCaptainCap("tvt", 31), 15);
  assert.equal(computeCaptainCap("tvt", 36), 18);
  assert.equal(computeCaptainCap("continental-championship", 31), 19);
});
