/**
 * FPL Classic — ranking rows into a leaderboard.
 *
 * The rule that matters most: `topN` truncates by RANK, not by row count, so a tie straddling
 * the cutoff returns every tied row. A "top 10" that silently dropped one of four managers tied
 * for 9th would misreport who actually won that gameweek.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { rankRows, topN, type Rankable } from "../../src/lib/fpl-classic/leaderboard";

function row(entrantId: string, value: number, name = entrantId, tieBreak: number | null = null): Rankable {
  return { entrantId, value, name, tieBreak };
}

test("strict descending order by value", () => {
  const out = rankRows([row("a", 50), row("b", 90), row("c", 70)]);
  assert.deepEqual(out.map((r) => r.entrantId), ["b", "c", "a"]);
});

test("competition ranking: equal values share a rank, the next rank SKIPS", () => {
  // [90, 90, 80] -> ranks 1, 1, 3 — never 1, 1, 2.
  const out = rankRows([row("a", 90), row("b", 90), row("c", 80)]);
  const ranks = out.map((r) => r.rank);
  assert.deepEqual(ranks.sort((x, y) => x - y), [1, 1, 3]);
  const first = out.find((r) => r.entrantId === "a")!;
  const second = out.find((r) => r.entrantId === "b")!;
  const third = out.find((r) => r.entrantId === "c")!;
  assert.equal(first.rank, 1);
  assert.equal(second.rank, 1);
  assert.equal(third.rank, 3);
  assert.equal(first.isTied, true);
  assert.equal(second.isTied, true);
  assert.equal(third.isTied, false);
});

test("tieBreak (FPL overall rank) breaks equal values before the name tiebreak", () => {
  const out = rankRows([
    row("a", 90, "Zed", 500),
    row("b", 90, "Alpha", 200), // lower overall rank = better, sorts first
  ]);
  assert.deepEqual(out.map((r) => r.entrantId), ["b", "a"]);
  // Still ranked 1 and 1 for the PUBLIC rank — tieBreak orders the rows, it does not un-tie them.
  assert.equal(out[0].rank, 1);
  assert.equal(out[1].rank, 1);
});

test("equal value AND equal tieBreak fall back to name, deterministically across repeated calls", () => {
  const rows = [row("a", 90, "Zed", 100), row("b", 90, "Alpha", 100)];
  const out1 = rankRows(rows).map((r) => r.entrantId);
  const out2 = rankRows(rows).map((r) => r.entrantId);
  assert.deepEqual(out1, ["b", "a"]); // Alpha < Zed
  assert.deepEqual(out2, out1);
});

test("a row with no tieBreak sorts after rows that have one, at the same value", () => {
  const out = rankRows([row("a", 90, "A", null), row("b", 90, "B", 5)]);
  assert.deepEqual(out.map((r) => r.entrantId), ["b", "a"]);
});

test("empty input returns empty; a single row is rank 1 and not tied", () => {
  assert.deepEqual(rankRows([]), []);
  const single = rankRows([row("a", 42)]);
  assert.equal(single.length, 1);
  assert.equal(single[0].rank, 1);
  assert.equal(single[0].isTied, false);
});

/* ── topN: truncate by RANK, not by row count ───────────────────────────── */

test("topN(_, 10) with a four-way tie for rank 9 returns 12 rows", () => {
  // Ranks 1-8 distinct (8 rows), then four rows tied at rank 9, then one row at rank 13.
  const rows: Rankable[] = [];
  for (let i = 0; i < 8; i++) rows.push(row(`solo${i}`, 100 - i));
  for (let i = 0; i < 4; i++) rows.push(row(`tied${i}`, 50));
  rows.push(row("last", 10));

  const out = topN(rows, 10);
  assert.equal(out.length, 12); // 8 solo + 4 tied at rank 9 — NOT truncated to 10
  assert.ok(out.every((r) => r.rank <= 10));
  assert.equal(out.filter((r) => r.rank === 9).length, 4);
  assert.ok(!out.some((r) => r.entrantId === "last")); // rank 13, correctly excluded
});

test("topN with no ties returns exactly N rows when there are more than N", () => {
  const rows = Array.from({ length: 15 }, (_, i) => row(`e${i}`, 100 - i));
  const out = topN(rows, 10);
  assert.equal(out.length, 10);
  assert.deepEqual(out.map((r) => r.rank), Array.from({ length: 10 }, (_, i) => i + 1));
});

test("topN with fewer rows than N returns all of them", () => {
  const rows = [row("a", 90), row("b", 80)];
  assert.equal(topN(rows, 10).length, 2);
});
