/**
 * JPL Auction release deadline: pending releases are confirmed and paid 24 hours before the next
 * mini-auction's scheduled start. With none scheduled the timer counts to the next GW deadline as a
 * tentative placeholder, at which nothing happens.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_DEADLINE_HOURS,
  describeReleaseConfirmation,
  isCountdownClosed,
  isReleaseWindowClosed,
  releaseCountdown,
  releaseDeadline,
} from "../../src/lib/formats/auction/release-deadline";

const AUCTION = { cycleNumber: 2, scheduledAt: new Date("2026-11-15T12:30:00Z") };
const DEADLINE = "2026-11-14T12:30:00.000Z";
const GW11 = { number: 11, deadline: new Date("2026-11-13T18:00:00Z") };

/* ── releaseDeadline / isReleaseWindowClosed ────────────────────────────── */

test("the deadline is 24 hours before the scheduled start", () => {
  assert.equal(RELEASE_DEADLINE_HOURS, 24);
  assert.equal(releaseDeadline(AUCTION.scheduledAt).toISOString(), DEADLINE);
});

test("the window closes exactly at the deadline", () => {
  assert.equal(isReleaseWindowClosed(AUCTION, new Date("2026-11-14T12:29:59Z")), false);
  assert.equal(isReleaseWindowClosed(AUCTION, new Date(DEADLINE)), true);
  // Still closed after the scheduled start if the admin hasn't started it yet.
  assert.equal(isReleaseWindowClosed(AUCTION, new Date("2026-11-16T00:00:00Z")), true);
});

test("with no mini-auction scheduled the window never closes", () => {
  assert.equal(isReleaseWindowClosed(null, new Date("2026-11-16T00:00:00Z")), false);
});

/* ── releaseCountdown ───────────────────────────────────────────────────── */

test("a scheduled mini-auction wins over the next GW deadline", () => {
  assert.deepEqual(releaseCountdown(AUCTION, GW11), { at: DEADLINE, tentative: false, cycleNumber: 2 });
});

test("with no mini-auction scheduled the next GW deadline is tentative", () => {
  assert.deepEqual(releaseCountdown(null, GW11), { at: "2026-11-13T18:00:00.000Z", tentative: true, gw: 11 });
});

test("no auction and no gameweek left means no countdown", () => {
  assert.equal(releaseCountdown(null, null), null);
});

/* ── isCountdownClosed ──────────────────────────────────────────────────── */

test("a real countdown closes releases once it reaches zero", () => {
  const c = releaseCountdown(AUCTION, null);
  assert.equal(isCountdownClosed(c, Date.parse(DEADLINE) - 1), false);
  assert.equal(isCountdownClosed(c, Date.parse(DEADLINE)), true);
});

test("a tentative countdown never closes releases, even once it has passed", () => {
  const c = releaseCountdown(null, GW11);
  assert.equal(isCountdownClosed(c, GW11.deadline.getTime() + 60_000), false);
  assert.equal(isCountdownClosed(null, Date.now()), false);
});

/* ── describeReleaseConfirmation ────────────────────────────────────────── */

test("the confirmation sentence names the mini-auction when one is scheduled", () => {
  assert.equal(
    describeReleaseConfirmation(releaseCountdown(AUCTION, null)),
    "Confirmed and paid 24 hours before Mini-Auction #2 starts."
  );
});

test("the confirmation sentence says when none is scheduled, tentative or not", () => {
  const unscheduled = "Confirmed and paid 24 hours before the next mini-auction starts — none is scheduled yet.";
  assert.equal(describeReleaseConfirmation(releaseCountdown(null, GW11)), unscheduled);
  assert.equal(describeReleaseConfirmation(null), unscheduled);
});
