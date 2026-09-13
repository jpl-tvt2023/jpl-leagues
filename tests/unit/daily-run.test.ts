/**
 * The daily processing run's two pure decisions: when a day's run may start, and how per-gameweek
 * outcomes roll up into a league's result.
 *
 * The scheduling half matters because there is no cron behind it — the whole schedule is "is it
 * past 09:00 IST, and has today been claimed". Get the timezone wrong and the run fires at the
 * wrong hour, or twice across a date boundary, with nothing to notice.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { istNow } from "../../src/lib/cron/ist-clock";
import {
  emptyLeagueResult,
  foldLeagueGwResult,
  finalizeLeagueResult,
} from "../../src/lib/cron/league-result";
import type { LeaguePlanItem, LeagueGwResult } from "../../src/lib/cron/process-all";

const league: LeaguePlanItem = {
  id: "lg1",
  slug: "tvt-26-27",
  format: "tvt",
  teamSize: 32,
  playoffStartGw: 31,
};

function gwResult(over: Partial<LeagueGwResult> = {}): LeagueGwResult {
  return {
    leagueId: league.id,
    slug: league.slug,
    gw: 1,
    status: "ok",
    scored: false,
    scoreSkipped: false,
    generated: false,
    generatedAlready: false,
    advanced: false,
    advanceSkipped: false,
    advanceWindowFuture: false,
    errors: [],
    ...over,
  };
}

/* ── IST clock ─────────────────────────────────────────────────────────── */

test("08:59 IST is before the run window, 09:01 is inside it", () => {
  // IST is UTC+5:30, so 09:00 IST is 03:30 UTC.
  assert.equal(istNow(new Date("2026-09-13T03:29:00Z")).hour, 8);
  assert.equal(istNow(new Date("2026-09-13T03:31:00Z")).hour, 9);
});

test("09:00 IST exactly is inside the window", () => {
  // A boundary that reads "before" would delay every run by an hour, silently.
  assert.equal(istNow(new Date("2026-09-13T03:30:00Z")).hour, 9);
});

test("the date is the IST date, not the UTC one", () => {
  // 20:00 UTC is already the next day in IST (01:30). A run keyed on the UTC date would claim
  // the same day twice across that boundary.
  assert.equal(istNow(new Date("2026-09-13T20:00:00Z")).date, "2026-09-14");
  assert.equal(istNow(new Date("2026-09-13T18:29:00Z")).date, "2026-09-13");
});

test("midnight IST reports hour 0, never 24", () => {
  // Some ICU builds render midnight as "24", which would read as past the window on the wrong day.
  const midnight = istNow(new Date("2026-09-13T18:30:00Z"));
  assert.equal(midnight.hour, 0);
  assert.equal(midnight.date, "2026-09-14");
});

test("the date format sorts lexicographically", () => {
  const a = istNow(new Date("2026-09-09T06:00:00Z")).date;
  const b = istNow(new Date("2026-09-10T06:00:00Z")).date;
  assert.ok(a < b, `${a} should sort before ${b}`);
  assert.match(a, /^\d{4}-\d{2}-\d{2}$/);
});

/* ── League result aggregation ─────────────────────────────────────────── */

test("a fresh aggregate claims no work and no errors", () => {
  const agg = finalizeLeagueResult(emptyLeagueResult(league));
  assert.equal(agg.status, "skipped");
  assert.deepEqual(agg.scoredGws, []);
  assert.deepEqual(agg.errors, []);
});

test("work with no errors is ok", () => {
  const agg = emptyLeagueResult(league);
  foldLeagueGwResult(agg, 1, { result: gwResult({ scored: true }) });
  foldLeagueGwResult(agg, 2, { result: gwResult({ gw: 2, advanced: true }) });
  finalizeLeagueResult(agg);

  assert.equal(agg.status, "ok");
  assert.deepEqual(agg.scoredGws, [1]);
  assert.deepEqual(agg.advancedGws, [2]);
});

test("a gameweek that needed nothing still counts as scored, not as a gap", () => {
  // scoreSkipped means the pre-flight found nothing unscored — the gameweek IS accounted for.
  const agg = emptyLeagueResult(league);
  foldLeagueGwResult(agg, 1, { result: gwResult({ scoreSkipped: true }) });
  finalizeLeagueResult(agg);

  assert.deepEqual(agg.scoredGws, [1]);
  assert.equal(agg.status, "ok");
});

test("work plus errors is partial; errors alone are an error", () => {
  const partial = emptyLeagueResult(league);
  foldLeagueGwResult(partial, 1, { result: gwResult({ scored: true }) });
  foldLeagueGwResult(partial, 2, {
    result: gwResult({ gw: 2, status: "error", errors: [{ step: "advance", message: "boom" }] }),
  });
  assert.equal(finalizeLeagueResult(partial).status, "partial");

  const failed = emptyLeagueResult(league);
  foldLeagueGwResult(failed, 1, {
    result: gwResult({ status: "error", errors: [{ step: "score", message: "boom" }] }),
  });
  assert.equal(finalizeLeagueResult(failed).status, "error");
});

test("a transport failure is recorded as 'request', never as 'score'", () => {
  // The call never produced a result, so which stage failed is unknown. Labelling every transport
  // failure as scoring is what made an auction league that never reached scoring report
  // "GW1 score: Network error".
  const agg = emptyLeagueResult(league);
  foldLeagueGwResult(agg, 3, { error: "fetch failed" });

  assert.equal(agg.errors.length, 1);
  assert.equal(agg.errors[0].step, "request");
  assert.equal(agg.errors[0].gw, 3);
  assert.equal(finalizeLeagueResult(agg).status, "error");
});

test("a missing result is an error rather than silent success", () => {
  const agg = emptyLeagueResult(league);
  foldLeagueGwResult(agg, 1, { result: null });

  assert.equal(agg.errors.length, 1);
  assert.equal(agg.errors[0].step, "request");
});

test("a gameweek blocked on FPL is tracked without counting as work", () => {
  // advanceWindowFuture means the gameweek is in the advance window but has not concluded on
  // FPL, so there was nothing to do yet — it must not make the league look "ok".
  const agg = emptyLeagueResult(league);
  foldLeagueGwResult(agg, 31, { result: gwResult({ gw: 31, advanceWindowFuture: true }) });
  finalizeLeagueResult(agg);

  assert.deepEqual(agg.advanceWindowFuture, [31]);
  assert.equal(agg.status, "skipped");
});

test("generate-already-in-place counts as work, so a re-run is not reported as idle", () => {
  const agg = emptyLeagueResult(league);
  foldLeagueGwResult(agg, 31, { result: gwResult({ gw: 31, generatedAlready: true }) });
  assert.equal(finalizeLeagueResult(agg).status, "ok");
});

test("folding is additive across chunks, which is how the daily run accumulates", () => {
  // Each chunk is a separate request; the aggregate is read back from Redis and folded into.
  let agg = emptyLeagueResult(league);
  for (const gw of [1, 2, 3]) {
    const roundTripped = JSON.parse(JSON.stringify(agg)) as typeof agg;
    agg = foldLeagueGwResult(roundTripped, gw, { result: gwResult({ gw, scored: true }) });
  }
  finalizeLeagueResult(agg);

  assert.deepEqual(agg.scoredGws, [1, 2, 3]);
  assert.equal(agg.status, "ok");
});

/* ── Claim and queue guards ────────────────────────────────────────────── */

/** Minimal stand-in for the Redis surface `daily-trigger` uses, recording every call. */
class FakeStore {
  data = new Map<string, unknown>();
  lists = new Map<string, string[]>();
  calls: string[] = [];

  async get<T>(key: string): Promise<T | null> {
    this.calls.push(`get ${key}`);
    return (this.data.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) {
    this.calls.push(`set ${key}${opts?.nx ? " nx" : ""}`);
    if (opts?.nx && this.data.has(key)) return null;
    this.data.set(key, value);
    return "OK";
  }
  async del(...keys: string[]) {
    this.calls.push(`del ${keys.join(",")}`);
    for (const k of keys) this.data.delete(k);
    return 1;
  }
  async rpush(key: string, ...values: string[]) {
    this.calls.push(`rpush ${key}`);
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }
  async expire(key: string) {
    this.calls.push(`expire ${key}`);
    return 1;
  }
  async lpop<T>(key: string): Promise<T | null> {
    this.calls.push(`lpop ${key}`);
    const list = this.lists.get(key) ?? [];
    return (list.shift() as T) ?? null;
  }
}

test("before 09:00 IST nothing is claimed and the store is not touched at all", async () => {
  const { maybeStartDailyRun, __setDailyTriggerStore } = await import(
    "../../src/lib/cron/daily-trigger"
  );
  const store = new FakeStore();
  __setDailyTriggerStore(store);
  try {
    // 03:29 UTC is 08:59 IST.
    const started = await maybeStartDailyRun(new Date("2026-09-13T03:29:00Z"));
    assert.equal(started, false);
    assert.deepEqual(store.calls, [], "the hour check must come before any Redis work");
  } finally {
    __setDailyTriggerStore(null);
  }
});

test("a day already claimed is a no-op — the run never starts twice", async () => {
  const { maybeStartDailyRun, __setDailyTriggerStore } = await import(
    "../../src/lib/cron/daily-trigger"
  );
  const store = new FakeStore();
  // Someone already claimed today.
  store.data.set("daily-run:claim:2026-09-13", "1");
  __setDailyTriggerStore(store);
  try {
    const started = await maybeStartDailyRun(new Date("2026-09-13T06:00:00Z"));
    assert.equal(started, false);
    assert.ok(
      !store.calls.some((c) => c.startsWith("rpush")),
      "a losing claim must not build a second queue",
    );
  } finally {
    __setDailyTriggerStore(null);
  }
});

test("an unclaimed day does no work — advancing is gated on the claim", async () => {
  const { advanceDailyRun, __setDailyTriggerStore } = await import(
    "../../src/lib/cron/daily-trigger"
  );
  const store = new FakeStore();
  __setDailyTriggerStore(store);
  try {
    const outcome = await advanceDailyRun("http://localhost", new Date("2026-09-13T06:00:00Z"));
    assert.equal(outcome, "idle");
    assert.ok(
      !store.calls.some((c) => c.startsWith("lpop")),
      "nothing should be taken off a queue that was never built",
    );
  } finally {
    __setDailyTriggerStore(null);
  }
});

test("a finished day stops advancing rather than polling an empty queue", async () => {
  const { advanceDailyRun, __setDailyTriggerStore } = await import(
    "../../src/lib/cron/daily-trigger"
  );
  const store = new FakeStore();
  store.data.set("daily-run:claim:2026-09-13", "1");
  store.data.set("daily-run:done:2026-09-13", "1");
  __setDailyTriggerStore(store);
  try {
    const outcome = await advanceDailyRun("http://localhost", new Date("2026-09-13T06:00:00Z"));
    assert.equal(outcome, "idle");
    assert.ok(!store.calls.some((c) => c.startsWith("lpop")));
  } finally {
    __setDailyTriggerStore(null);
  }
});

test("a held chunk lock keeps a second concurrent request out", async () => {
  const { advanceDailyRun, __setDailyTriggerStore } = await import(
    "../../src/lib/cron/daily-trigger"
  );
  const store = new FakeStore();
  store.data.set("daily-run:claim:2026-09-13", "1");
  store.data.set("daily-run:chunk:2026-09-13", "1"); // another request is mid-chunk
  __setDailyTriggerStore(store);
  try {
    const outcome = await advanceDailyRun("http://localhost", new Date("2026-09-13T06:00:00Z"));
    assert.equal(outcome, "idle");
    assert.ok(
      !store.calls.some((c) => c.startsWith("lpop")),
      "two requests must never take the same queue item",
    );
  } finally {
    __setDailyTriggerStore(null);
  }
});
