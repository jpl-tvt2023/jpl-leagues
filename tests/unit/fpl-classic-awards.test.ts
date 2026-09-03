/**
 * FPL Classic — the award registry.
 *
 * The two rules that matter most:
 *  - no award of ANY kind fires before its required gameweeks are settled (the freeze gate this
 *    module exists to compute for lib/fpl-classic/sync.ts);
 *  - a late joiner is excluded from a gameweek/month award for any period before they joined,
 *    even though their full history counts toward the season total elsewhere.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  AWARD_DEFINITIONS,
  allScopes,
  isScopeReady,
  computeAllAwards,
  type AwardContext,
  type AwardEntrantRow,
  type AwardGwRow,
} from "../../src/lib/fpl-classic/awards";

function entrant(id: string, firstSeenGw = 1): AwardEntrantRow {
  return { id, playerName: `Player ${id}`, entryName: `Entry ${id}`, firstSeenGw };
}
function row(entrantId: string, gw: number, points: number, opts: Partial<AwardGwRow> = {}): AwardGwRow {
  return {
    entrantId, gw, points, netPoints: opts.netPoints ?? points, benchPoints: opts.benchPoints ?? 0,
    monthKey: opts.monthKey ?? "2025-08",
  };
}

const baseCtx = (over: Partial<AwardContext> = {}): AwardContext => ({
  entrants: [entrant("a"), entrant("b"), entrant("c")],
  rows: [],
  months: [{ key: "2025-08", label: "August 2025", gws: [1, 2] }],
  startGameweek: 1,
  settledThroughGw: 2,
  metric: "net",
  winnerCutPercent: 30,
  ...over,
});

test("no award fires before its required gameweeks are settled", () => {
  const ctx = baseCtx({
    rows: [row("a", 5, 80)],
    settledThroughGw: 4, // GW5 not yet settled
  });
  const gwAward = AWARD_DEFINITIONS.find((a) => a.key === "gw-winner")!;
  assert.equal(isScopeReady(ctx, gwAward, "gw:5"), false);
  assert.equal(gwAward.compute(ctx, "gw:5"), null);
});

test("a gameweek award fires once its own gameweek is settled", () => {
  const ctx = baseCtx({
    rows: [row("a", 1, 80), row("b", 1, 60)],
    settledThroughGw: 1,
  });
  const gwAward = AWARD_DEFINITIONS.find((a) => a.key === "gw-winner")!;
  assert.equal(isScopeReady(ctx, gwAward, "gw:1"), true);
  const result = gwAward.compute(ctx, "gw:1")!;
  assert.equal(result.winners.length, 1);
  assert.equal(result.winners[0].entrantId, "a");
  assert.equal(result.winners[0].value, 80);
});

test("gw-winner: a tie at the top produces two winners, both position 1", () => {
  const ctx = baseCtx({ rows: [row("a", 1, 80), row("b", 1, 80), row("c", 1, 50)], settledThroughGw: 1 });
  const gwAward = AWARD_DEFINITIONS.find((a) => a.key === "gw-winner")!;
  const result = gwAward.compute(ctx, "gw:1")!;
  assert.equal(result.winners.length, 2);
  assert.ok(result.winners.every((w) => w.position === 1 && w.isTied));
});

test("gw-winner excludes an entrant who joined after that gameweek", () => {
  const ctx = baseCtx({
    entrants: [entrant("a", 1), entrant("b", 5)], // b joined at GW5
    rows: [row("a", 1, 50), row("b", 1, 999)], // b's row shouldn't exist pre-join, but even if it did:
    settledThroughGw: 1,
  });
  const gwAward = AWARD_DEFINITIONS.find((a) => a.key === "gw-winner")!;
  const result = gwAward.compute(ctx, "gw:1")!;
  assert.equal(result.winners.length, 1);
  assert.equal(result.winners[0].entrantId, "a");
});

test("month-winner requires EVERY gameweek in the month to be settled", () => {
  const ctx = baseCtx({
    rows: [row("a", 1, 50), row("b", 1, 40)],
    months: [{ key: "2025-08", label: "August 2025", gws: [1, 2] }],
    settledThroughGw: 1, // GW2 not settled yet
  });
  const monthAward = AWARD_DEFINITIONS.find((a) => a.key === "month-winner")!;
  assert.equal(isScopeReady(ctx, monthAward, "month:2025-08"), false);
  assert.equal(monthAward.compute(ctx, "month:2025-08"), null);
});

test("month-winner sums across the month once fully settled", () => {
  const ctx = baseCtx({
    rows: [row("a", 1, 50), row("a", 2, 30), row("b", 1, 40), row("b", 2, 45)],
    months: [{ key: "2025-08", label: "August 2025", gws: [1, 2] }],
    settledThroughGw: 2,
  });
  const monthAward = AWARD_DEFINITIONS.find((a) => a.key === "month-winner")!;
  const result = monthAward.compute(ctx, "month:2025-08")!;
  // a: 80, b: 85 -> b wins
  assert.equal(result.winners.length, 1);
  assert.equal(result.winners[0].entrantId, "b");
  assert.equal(result.winners[0].value, 85);
});

test("month-winner excludes an entrant who joined partway through the month", () => {
  const ctx = baseCtx({
    entrants: [entrant("a", 1), entrant("b", 2)], // b joined at GW2, month is GW1-2
    rows: [row("a", 1, 10), row("a", 2, 10), row("b", 2, 999)],
    months: [{ key: "2025-08", label: "August 2025", gws: [1, 2] }],
    settledThroughGw: 2,
  });
  const monthAward = AWARD_DEFINITIONS.find((a) => a.key === "month-winner")!;
  const result = monthAward.compute(ctx, "month:2025-08")!;
  assert.equal(result.winners.length, 1);
  assert.equal(result.winners[0].entrantId, "a"); // b excluded despite the huge score
});

test("season-podium never fires before GW38 is settled, whatever startGameweek is", () => {
  const ctx = baseCtx({ startGameweek: 1, settledThroughGw: 37 });
  const seasonAward = AWARD_DEFINITIONS.find((a) => a.key === "season-podium")!;
  assert.equal(seasonAward.compute(ctx, "season"), null);
});

test("season-podium: a two-way tie for 2nd leaves no 3rd place", () => {
  const ctx = baseCtx({
    entrants: [entrant("a"), entrant("b"), entrant("c"), entrant("d")],
    rows: [row("a", 1, 100), row("b", 1, 80), row("c", 1, 80), row("d", 1, 50)],
    settledThroughGw: 38,
  });
  const seasonAward = AWARD_DEFINITIONS.find((a) => a.key === "season-podium")!;
  const result = seasonAward.compute(ctx, "season")!;
  const positions = result.winners.map((w) => w.position).sort((x, y) => x - y);
  assert.deepEqual(positions, [1, 2, 2]); // no rank-3 winner listed; d (rank 4) excluded from top-3 cap
});

test("highest-gw-score carries the gw it happened in", () => {
  const ctx = baseCtx({
    rows: [row("a", 1, 40), row("a", 2, 95), row("b", 1, 60)],
    settledThroughGw: 38,
  });
  const award = AWARD_DEFINITIONS.find((a) => a.key === "highest-gw-score")!;
  const result = award.compute(ctx, "season")!;
  assert.equal(result.winners[0].entrantId, "a");
  assert.equal(result.winners[0].value, 95);
  assert.equal(result.winners[0].detail?.gw, 2);
});

test("best-bench sums bench points across the season, ties shared", () => {
  const ctx = baseCtx({
    rows: [
      row("a", 1, 50, { benchPoints: 5 }), row("a", 2, 50, { benchPoints: 5 }),
      row("b", 1, 50, { benchPoints: 4 }), row("b", 2, 50, { benchPoints: 6 }),
    ],
    settledThroughGw: 38,
  });
  const award = AWARD_DEFINITIONS.find((a) => a.key === "best-bench")!;
  const result = award.compute(ctx, "season")!;
  // a: 10, b: 10 -> tied
  assert.equal(result.winners.length, 2);
  assert.ok(result.winners.every((w) => w.value === 10 && w.isTied));
});

test("no award result ever carries a prize, amount, or currency field", () => {
  const ctx = baseCtx({
    rows: [row("a", 1, 80), row("b", 1, 60), row("a", 2, 30), row("b", 2, 20)],
    settledThroughGw: 38,
  });
  const results = computeAllAwards(ctx);
  assert.ok(results.length > 0, "sanity: some awards should have fired");
  const serialized = JSON.stringify(results);
  assert.doesNotMatch(serialized, /prize|amount|currency|rupee|dollar/i);
});

test("allScopes enumerates a gw: and month: scope per settled period, plus season/special once", () => {
  const ctx = baseCtx({
    rows: [row("a", 1, 10), row("a", 2, 10)],
    months: [{ key: "2025-08", label: "August 2025", gws: [1, 2] }],
  });
  const scopes = allScopes(ctx);
  const keys = scopes.map((s) => `${s.award.key}:${s.scopeKey}`);
  assert.ok(keys.includes("gw-winner:gw:1"));
  assert.ok(keys.includes("gw-winner:gw:2"));
  assert.ok(keys.includes("month-winner:month:2025-08"));
  assert.ok(keys.includes("season-podium:season"));
});
