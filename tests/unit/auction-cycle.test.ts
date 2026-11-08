/**
 * JPL Auction mini-auction gameweeks (stored as release_cycle_gws).
 * These used to be the hardcoded arithmetic `gameweekNumber % 10 === 0` (GW 10/20/30) and
 * decided when releases confirmed. They are now a per-league list and purely informational —
 * releases confirm 24 hours before the mini-auction (see auction-release-deadline.test.ts).
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RELEASE_CYCLE_GWS,
  formatReleaseCycleGws,
  parseReleaseCycleGws,
  validateReleaseCycleGws,
} from "../../src/lib/formats/auction/cycle";

/* ── parseReleaseCycleGws ───────────────────────────────────────────────── */

test("parses a stored list, sorted and de-duplicated", () => {
  assert.deepEqual(parseReleaseCycleGws("[28,18,28]"), [18, 28]);
});

test("malformed input falls back to the legacy cadence, never to an empty list", () => {
  // An empty list would leave the rules page with no gameweeks to name.
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

