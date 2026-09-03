/**
 * FPL Classic — bucketing gameweeks into calendar months.
 *
 * The rule under test is stated plainly in months.ts: a gameweek belongs to the UTC calendar
 * month of its DEADLINE, never the month its matches are actually played in, and never the
 * viewer's local timezone. The Nov-29-deadline case below is the whole point of the rule — it's
 * the case where "deadline month" and "matches played in" visibly disagree.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  monthKeyFromDeadline,
  monthLabel,
  buildMonthBuckets,
  defaultMonthKey,
} from "../../src/lib/fpl-classic/months";

test("a deadline late in the month buckets by DEADLINE month, not by when matches are played", () => {
  // Friday 18:30 UTC, 29 Nov — the gameweek's matches run into December, but the gameweek itself
  // is November's.
  assert.equal(monthKeyFromDeadline("2025-11-29T18:30:00Z"), "2025-11");
});

test("a deadline just after midnight UTC on the 1st is the NEW month", () => {
  assert.equal(monthKeyFromDeadline("2026-01-01T11:00:00Z"), "2026-01");
});

test("bucketing is independent of the process timezone", () => {
  // A deadline of 2025-11-30T23:30:00Z is still November in UTC no matter what TZ this process
  // runs under (e.g. a positive-offset zone like Asia/Kolkata, where the same instant is already
  // Dec 1 local time). Getters used here (getUTCFullYear/getUTCMonth) are TZ-independent by
  // construction, so this assertion is a guard against someone "simplifying" to the non-UTC
  // getters later, not a claim that this process's TZ matters today.
  assert.equal(monthKeyFromDeadline("2025-11-30T23:30:00Z"), "2025-11");
});

test("monthLabel renders the human form, and passes through anything malformed", () => {
  assert.equal(monthLabel("2025-11"), "November 2025");
  assert.equal(monthLabel("2026-01"), "January 2026");
  assert.equal(monthLabel("not-a-key"), "not-a-key");
});

function gw(n: number, deadlineIso: string) {
  return { gw: n, deadlineTime: deadlineIso };
}

test("a realistic season's worth of deadlines buckets Aug through May with no gaps", () => {
  // One deadline per month for 10 months, GW1..GW10 — enough to prove ordering and non-overlap
  // without hand-writing 38 real FPL dates.
  const months = ["08", "09", "10", "11", "12", "01", "02", "03", "04", "05"];
  const years = ["2025", "2025", "2025", "2025", "2025", "2026", "2026", "2026", "2026", "2026"];
  const gws = months.map((m, i) => gw(i + 1, `${years[i]}-${m}-15T18:30:00Z`));

  const buckets = buildMonthBuckets(gws);
  assert.equal(buckets.length, 10);
  assert.deepEqual(buckets.map((b) => b.key), [
    "2025-08", "2025-09", "2025-10", "2025-11", "2025-12",
    "2026-01", "2026-02", "2026-03", "2026-04", "2026-05",
  ]);
  // Chronological order, not alphabetical-by-label — 2026-01 sorts after 2025-12.
  for (const b of buckets) assert.equal(b.gws.length, 1);
});

test("a month with exactly one gameweek is still its own bucket", () => {
  const buckets = buildMonthBuckets([gw(1, "2025-08-15T18:30:00Z"), gw(2, "2025-09-01T18:30:00Z")]);
  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets[0].gws, [1]);
  assert.deepEqual(buckets[1].gws, [2]);
});

test("multiple gameweeks in one month sort ascending inside the bucket", () => {
  const buckets = buildMonthBuckets([
    gw(3, "2025-11-22T18:30:00Z"),
    gw(1, "2025-11-01T18:30:00Z"),
    gw(2, "2025-11-08T18:30:00Z"),
  ]);
  assert.equal(buckets.length, 1);
  assert.deepEqual(buckets[0].gws, [1, 2, 3]);
});

test("an empty gameweek list yields no buckets, not a crash", () => {
  assert.deepEqual(buildMonthBuckets([]), []);
});

/* ── defaultMonthKey ─────────────────────────────────────────────────────── */

test("defaultMonthKey returns the bucket containing the current gameweek", () => {
  const buckets = buildMonthBuckets([
    gw(1, "2025-08-15T18:30:00Z"),
    gw(2, "2025-09-01T18:30:00Z"),
    gw(3, "2025-09-08T18:30:00Z"),
  ]);
  assert.equal(defaultMonthKey(buckets, 3), "2025-09");
  assert.equal(defaultMonthKey(buckets, 1), "2025-08");
});

test("defaultMonthKey falls back to the last complete month when currentGw is null", () => {
  const buckets = buildMonthBuckets([gw(1, "2025-08-15T18:30:00Z"), gw(2, "2025-09-01T18:30:00Z")]);
  assert.equal(defaultMonthKey(buckets, null), "2025-09");
});

test("defaultMonthKey is null only when there are no buckets at all", () => {
  assert.equal(defaultMonthKey([], null), null);
  assert.equal(defaultMonthKey([], 5), null);
});

test("defaultMonthKey falls back to the last bucket when currentGw is not in any of them", () => {
  const buckets = buildMonthBuckets([gw(1, "2025-08-15T18:30:00Z"), gw(2, "2025-09-01T18:30:00Z")]);
  // currentGw=99 does not exist in this season's buckets.
  assert.equal(defaultMonthKey(buckets, 99), "2025-09");
});
