/**
 * Pure-function tests for the submission-window resolver.
 *
 * Run with: npm run test:unit
 *
 * These use node:test rather than Playwright because resolveSubmissionWindow
 * touches no DB, no network and no browser — driving it through an HTTP spec
 * would be slower and would obscure which branch actually broke.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSubmissionWindow,
  SUBMISSION_LOCK_MS,
  FORCE_OPEN_WITHIN_MS,
} from "../../src/lib/gameweek-window";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Build a gameweek list with deadlines spaced a week apart from `firstDeadline`. */
function gws(numbers: number[], firstDeadline: Date, spacingMs = 7 * DAY) {
  return numbers.map((n, i) => ({
    id: `gw-${n}`,
    number: n,
    deadline: new Date(firstDeadline.getTime() + i * spacingMs),
  }));
}

const T0 = new Date("2026-08-14T11:00:00.000Z");

test("GW1 is exempt — nothing precedes it, so it opens even with no finished GWs", () => {
  const list = gws([1, 2, 3], T0);
  const now = new Date(T0.getTime() - HOUR);
  const w = resolveSubmissionWindow(list, now, new Set());
  assert.equal(w.state, "open");
  assert.equal(w.gw?.number, 1);
  assert.equal(w.awaitingGw, null);
  assert.equal(w.degraded, false);
});

test("inside the 30-minute post-deadline blackout the window is locked", () => {
  const list = gws([1, 2, 3], T0);
  const now = new Date(T0.getTime() + 5 * 60 * 1000);
  const w = resolveSubmissionWindow(list, now, new Set());
  assert.equal(w.state, "locked");
  assert.equal(w.gw?.number, 1);
  assert.equal(w.opensAt, new Date(T0.getTime() + SUBMISSION_LOCK_MS).toISOString());
});

test("after the blackout, GW2 stays shut while FPL has not finished GW1", () => {
  const list = gws([1, 2, 3], T0);
  const now = new Date(T0.getTime() + 2 * HOUR);
  const w = resolveSubmissionWindow(list, now, new Set());
  assert.equal(w.state, "awaiting-results");
  assert.equal(w.gw?.number, 2, "the window still refers to the GW being gated");
  assert.equal(w.awaitingGw, 1);
  assert.equal(w.degraded, false);
});

test("once FPL marks GW1 finished, GW2 opens", () => {
  const list = gws([1, 2, 3], T0);
  const now = new Date(T0.getTime() + 2 * HOUR);
  const w = resolveSubmissionWindow(list, now, new Set([1]));
  assert.equal(w.state, "open");
  assert.equal(w.gw?.number, 2);
  assert.equal(w.awaitingGw, null);
});

test("FPL outage fails OPEN and flags itself as degraded", () => {
  const list = gws([1, 2, 3], T0);
  const now = new Date(T0.getTime() + 2 * HOUR);
  const w = resolveSubmissionWindow(list, now, null);
  assert.equal(w.state, "open");
  assert.equal(w.gw?.number, 2);
  assert.equal(w.degraded, true, "callers show a caveat rather than silently trusting it");
});

test("the 24h safety valve opens the window even when the previous GW is unfinished", () => {
  const list = gws([1, 2, 3], T0);
  // 12h before GW2's deadline — inside the valve.
  const gw2Deadline = list[1].deadline;
  const now = new Date(gw2Deadline.getTime() - 12 * HOUR);
  const w = resolveSubmissionWindow(list, now, new Set());
  assert.equal(w.state, "open");
  assert.equal(w.gw?.number, 2);
  assert.equal(w.degraded, false);
  // Sanity: just outside the valve it is still gated.
  const earlier = new Date(gw2Deadline.getTime() - FORCE_OPEN_WITHIN_MS - HOUR);
  assert.equal(resolveSubmissionWindow(list, earlier, new Set()).state, "awaiting-results");
});

test("requirePreviousFinished:false restores the old behaviour for other formats", () => {
  const list = gws([1, 2, 3], T0);
  const now = new Date(T0.getTime() + 2 * HOUR);
  const w = resolveSubmissionWindow(list, now, new Set(), { requirePreviousFinished: false });
  assert.equal(w.state, "open");
  assert.equal(w.gw?.number, 2);
});

test("gating uses the array-previous gameweek, not number - 1", () => {
  // A non-contiguous list, as a playoff phase produces. GW33 is preceded by
  // GW31 in this league; waiting on a non-existent GW32 would deadlock.
  const list = gws([30, 31, 33], T0);
  const now = new Date(list[1].deadline.getTime() + 2 * HOUR);
  const gated = resolveSubmissionWindow(list, now, new Set(), {
    forceOpenWithinMs: 0, // disable the valve so we test the gate itself
  });
  assert.equal(gated.state, "awaiting-results");
  assert.equal(gated.awaitingGw, 31, "waits on GW31, the actual previous gameweek");

  const opened = resolveSubmissionWindow(list, now, new Set([31]), { forceOpenWithinMs: 0 });
  assert.equal(opened.state, "open");
  assert.equal(opened.gw?.number, 33);
});

test("past the final deadline the window is closed", () => {
  const list = gws([1, 2], T0);
  const now = new Date(list[1].deadline.getTime() + DAY);
  const w = resolveSubmissionWindow(list, now, new Set([1, 2]));
  assert.equal(w.state, "closed");
  assert.equal(w.gw, null);
  assert.equal(w.awaitingGw, null);
});

test("an empty gameweek list is closed, not a crash", () => {
  const w = resolveSubmissionWindow([], new Date(), new Set());
  assert.equal(w.state, "closed");
  assert.equal(w.gw, null);
});
