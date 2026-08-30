/**
 * JPL Auction release-cycle gameweeks.
 *
 * These boundaries used to be the hardcoded arithmetic `gameweekNumber % 10 === 0`
 * (GW 10/20/30). They are now a per-league list, so the critical property is that a
 * league on the default list behaves EXACTLY as it did before — every existing league
 * relies on that.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RELEASE_CYCLE_GWS,
  formatReleaseCycleGws,
  isReleaseCycleBoundary,
  parseReleaseCycleGws,
  validateReleaseCycleGws,
} from "../../src/lib/formats/auction/cycle";

/* ── isReleaseCycleBoundary ─────────────────────────────────────────────── */

test("default list reproduces the legacy gw % 10 === 0 cadence exactly", () => {
  for (let gw = 1; gw <= 38; gw++) {
    assert.equal(
      isReleaseCycleBoundary(gw, DEFAULT_RELEASE_CYCLE_GWS),
      gw % 10 === 0 && gw <= 30,
      `GW${gw} disagreed with the legacy cadence`
    );
  }
});

test("a custom list fires only on its own gameweeks", () => {
  const cycles = [18, 28];
  assert.equal(isReleaseCycleBoundary(18, cycles), true);
  assert.equal(isReleaseCycleBoundary(28, cycles), true);
  assert.equal(isReleaseCycleBoundary(20, cycles), false);
  assert.equal(isReleaseCycleBoundary(30, cycles), false);
});

/* ── parseReleaseCycleGws ───────────────────────────────────────────────── */

test("parses a stored list, sorted and de-duplicated", () => {
  assert.deepEqual(parseReleaseCycleGws("[28,18,28]"), [18, 28]);
});

test("malformed input falls back to the legacy cadence, never to an empty list", () => {
  // An empty list would silently disable release finalization league-wide.
  for (const raw of [null, undefined, "", "not json", "{}", "[]", '["a","b"]', "[0,99]"]) {
    assert.deepEqual(parseReleaseCycleGws(raw), DEFAULT_RELEASE_CYCLE_GWS, `raw=${String(raw)}`);
  }
});

test("out-of-range entries are dropped but valid ones survive", () => {
  assert.deepEqual(parseReleaseCycleGws("[0,12,39,24]"), [12, 24]);
});

test("parse returns a fresh array, so callers cannot mutate the shared default", () => {
  const first = parseReleaseCycleGws(null);
  first.push(99);
  assert.deepEqual(parseReleaseCycleGws(null), DEFAULT_RELEASE_CYCLE_GWS);
});

/* ── validateReleaseCycleGws ────────────────────────────────────────────── */

test("accepts an array and returns it sorted", () => {
  const res = validateReleaseCycleGws([30, 10, 20], 1);
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.gws, [10, 20, 30]);
});

test("accepts the comma-separated string the admin UI collects", () => {
  const res = validateReleaseCycleGws(" 18 , 28 ", 15);
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.gws, [18, 28]);
});

test("rejects duplicates rather than silently collapsing them", () => {
  assert.equal(validateReleaseCycleGws([5, 5], 1).ok, false);
});

test("rejects empty, non-integer, and out-of-range input", () => {
  assert.equal(validateReleaseCycleGws([], 1).ok, false);
  assert.equal(validateReleaseCycleGws("", 1).ok, false);
  assert.equal(validateReleaseCycleGws("10,,20", 1).ok, false);
  assert.equal(validateReleaseCycleGws([10.5], 1).ok, false);
  assert.equal(validateReleaseCycleGws([40], 1).ok, false);
  assert.equal(validateReleaseCycleGws({ gw: 10 }, 1).ok, false);
});

test("rejects a boundary that falls before the league's first gameweek", () => {
  assert.equal(validateReleaseCycleGws([10], 15).ok, false);
  assert.equal(validateReleaseCycleGws([15], 15).ok, true);
});

test("rejects more boundaries than there can be mini-auctions", () => {
  assert.equal(validateReleaseCycleGws([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1).ok, true);
  assert.equal(validateReleaseCycleGws([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 1).ok, false);
});

/* ── formatReleaseCycleGws ──────────────────────────────────────────────── */

test("formats the cadence the way the UI copy reads", () => {
  assert.equal(formatReleaseCycleGws([10, 20, 30]), "GW 10/20/30");
  assert.equal(formatReleaseCycleGws([18]), "GW 18");
});
