/**
 * FPL chip status per manager, built against the SEASON's chip list.
 *
 * Regression cover for the hardcoded 2024/25 set: every manager showed an "available" Assistant
 * Manager in 2026/27 (the chip no longer exists), only one Bench Boost / Triple Captain / Free Hit
 * although there is one per half, and first-half chips as available after GW19.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFplChipStatus,
  chipState,
  DEFAULT_SEASON_CHIPS,
  fplChipBaseCode,
  fplChipLabel,
  seasonChipSlots,
  type FplSeasonChip,
} from "../../src/lib/fpl-league/chips";

const chip = (name: string, event: number) => ({ name, time: "", event });

test("2026/27: one of each chip per half, no Assistant Manager", () => {
  const slots = seasonChipSlots(DEFAULT_SEASON_CHIPS);
  assert.deepEqual(
    slots.map((s) => s.code),
    ["WC1", "FH1", "BB1", "TC1", "WC2", "FH2", "BB2", "TC2"],
    "first-half set, then second-half set",
  );
  assert.ok(!slots.some((s) => s.code.startsWith("AM")));
  assert.equal(slots.find((s) => s.code === "BB2")!.label, "Bench Boost 2 (GW20–38)");
  assert.deepEqual(buildFplChipStatus([]).available, slots.map((s) => s.code));
});

test("a chip is matched to the half it was played in, not to play order", () => {
  // The old rule called the first Wildcard WC1 wherever it fell.
  const status = buildFplChipStatus([chip("wildcard", 25), chip("bboost", 24)]);
  assert.deepEqual(status.used, [{ code: "BB2", gw: 24 }, { code: "WC2", gw: 25 }]);
  assert.ok(status.available.includes("WC1") && status.available.includes("BB1"));
});

test("both halves' Bench Boosts are tracked separately", () => {
  const status = buildFplChipStatus([chip("bboost", 5), chip("bboost", 30), chip("3xc", 7)]);
  assert.deepEqual(status.used.map((u) => u.code), ["BB1", "TC1", "BB2"]);
  assert.deepEqual(status.available, ["WC1", "FH1", "WC2", "FH2", "TC2"]);
});

test("an unplayed first-half chip expires after its window", () => {
  const bb1 = seasonChipSlots().find((s) => s.code === "BB1")!;
  assert.equal(chipState(null, 19, bb1), "available");
  assert.equal(chipState(null, 20, bb1), "expired");
  assert.equal(chipState(5, 20, bb1), "past", "a played chip is never 'expired'");
  assert.equal(chipState(null, 20), "available", "no window known, no expiry");
});

test("the season list drives the slots: a 2024/25-style season still works", () => {
  const season2425: FplSeasonChip[] = [
    { name: "wildcard", start_event: 2, stop_event: 20 },
    { name: "wildcard", start_event: 21, stop_event: 38 },
    { name: "bboost", start_event: 1, stop_event: 38 },
    { name: "3xc", start_event: 1, stop_event: 38 },
    { name: "freehit", start_event: 2, stop_event: 38 },
    { name: "manager", start_event: 24, stop_event: 38 },
  ];
  assert.deepEqual(seasonChipSlots(season2425).map((s) => s.code), ["WC1", "FH", "BB", "TC", "AM", "WC2"]);
  const status = buildFplChipStatus([chip("manager", 30)], season2425);
  assert.deepEqual(status.used, [{ code: "AM", gw: 30 }]);
});

test("a chip the season list does not know is kept under its own name, not dropped", () => {
  const status = buildFplChipStatus([chip("newchip", 3)]);
  assert.deepEqual(status.used, [{ code: "newchip", gw: 3 }]);
});

test("labels read both the per-half codes and the older ones still in stored reasons", () => {
  assert.equal(fplChipLabel("BB2"), "Bench Boost 2");
  assert.equal(fplChipLabel("WC1"), "Wildcard 1");
  assert.equal(fplChipLabel("TC"), "Triple Captain");
  assert.equal(fplChipLabel("AM"), "Assistant Manager");
  assert.equal(fplChipLabel("newchip"), "newchip");
  assert.equal(fplChipBaseCode("FH2"), "FH");
});
