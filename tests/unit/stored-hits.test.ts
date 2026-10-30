/**
 * Reading managers' transfer hits back out of a result's stored per-player breakdown
 * (lib/scoring/stored-hits.ts).
 *
 * League standings and the scoring carry-forward both take hits from here now, in place of a
 * full-keyspace Redis SCAN. The rule that matters is the null: anything short of a complete,
 * well-formed breakdown must say "can't answer" so the caller falls back, because reading a
 * partial breakdown as "nobody took a hit" silently drops a -1 league point or a carry-forward
 * deduction.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { playerHitsFromStoredScores } from "../../src/lib/scoring/stored-hits";

/** The shape api/gameweeks/[gw]/route.ts writes. */
function breakdown(...entries: object[]): string {
  return JSON.stringify(entries);
}

test("reads fplId → transferHits for every manager on the side", () => {
  const raw = breakdown(
    { name: "A", fplId: "101", fplScore: 60, transferHits: 16, isCaptain: true, finalScore: 88 },
    { name: "B", fplId: "202", fplScore: 41, transferHits: 0, isCaptain: false, finalScore: 41 },
  );
  assert.deepEqual([...playerHitsFromStoredScores(raw)!], [
    ["101", 16],
    ["202", 0],
  ]);
});

test("no breakdown at all (legacy or Continental Championship rows) cannot answer", () => {
  assert.equal(playerHitsFromStoredScores(null), null);
  assert.equal(playerHitsFromStoredScores(undefined), null);
  assert.equal(playerHitsFromStoredScores(""), null);
});

test("malformed or non-array JSON cannot answer", () => {
  assert.equal(playerHitsFromStoredScores("{not json"), null);
  assert.equal(playerHitsFromStoredScores(JSON.stringify({ fplId: "1" })), null);
});

test("an empty breakdown cannot answer — it does not vouch for a side with managers", () => {
  assert.equal(playerHitsFromStoredScores("[]"), null);
});

test("an entry the processor could not attribute (empty fplId) poisons the whole side", () => {
  const raw = breakdown(
    { fplId: "101", transferHits: 4 },
    { fplId: "", transferHits: 20 }, // player row deleted before scoring
  );
  assert.equal(playerHitsFromStoredScores(raw), null);
});

test("a missing or non-numeric transferHits poisons the whole side rather than reading as 0", () => {
  assert.equal(playerHitsFromStoredScores(breakdown({ fplId: "101" })), null);
  assert.equal(playerHitsFromStoredScores(breakdown({ fplId: "101", transferHits: "16" })), null);
});
