/**
 * The fixtures page's GW stats sidebar, folded from per-manager facts.
 *
 * Pinned here: Wildcard AND Free Hit transfers never count toward "most transferred", effective
 * ownership counts the armband, and the group scope really narrows every list.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateGwStats,
  PICK_CAPTAIN,
  PICK_VICE,
  type GwStatsManager,
  type GwStatsPayload,
} from "../../src/lib/fixtures-stats/aggregate";

function squad(captain: number, captainMult = 2): [number, number, number][] {
  // 11 starters + 4 bench; elements 100.. are filler, distinct per captain to keep counts clean.
  const picks: [number, number, number][] = [[captain, captainMult, PICK_CAPTAIN], [1, 1, PICK_VICE]];
  for (let i = 0; i < 9; i++) picks.push([200 + i, 1, 0]);
  for (let i = 0; i < 4; i++) picks.push([300 + i, 0, 0]);
  return picks;
}

function mgr(id: string, group: string, opts: Partial<GwStatsManager> = {}): GwStatsManager {
  return {
    fplId: id,
    name: `M${id}`,
    teamId: `T${id}`,
    teamName: `Team ${id}`,
    group,
    picks: squad(10),
    chip: null,
    hits: 0,
    gross: 50,
    transfers: { in: [], out: [] },
    ...opts,
  };
}

function payload(managers: GwStatsManager[]): GwStatsPayload {
  return {
    gameweek: 7,
    status: "ok",
    settled: false,
    managers,
    elements: {
      10: { n: "Haaland", pos: 4, club: "MCI", pts: 13 },
      11: { n: "Salah", pos: 3, club: "LIV", pts: 2 },
      1: { n: "Raya", pos: 1, club: "ARS", pts: 6 },
      50: { n: "Isak", pos: 4, club: "LIV", pts: 5 },
      51: { n: "Watkins", pos: 4, club: "AVL", pts: 1 },
    },
    picksComplete: true,
    transfersComplete: true,
    generatedAt: "2026-10-03T12:00:00Z",
  };
}

test("most captained counts the armband, and says how many were Triple Captains", () => {
  const stats = aggregateGwStats(
    payload([
      mgr("1", "A"),
      mgr("2", "A", { chip: "3xc", picks: squad(10, 3) }),
      mgr("3", "B", { picks: squad(11) }),
    ]),
    "all",
  );
  assert.equal(stats.managerCount, 3);
  assert.equal(stats.captained[0].name, "Haaland");
  assert.equal(stats.captained[0].value, 2);
  assert.equal(stats.captained[0].pct, 67);
  assert.equal(stats.captained[0].extra, "1 TC");
  assert.deepEqual(stats.captained[0].managers.map((m) => m.note), ["C", "TC"]);
});

test("transfers: Wildcard and Free Hit moves are excluded, and those managers are listed", () => {
  const stats = aggregateGwStats(
    payload([
      mgr("1", "A", { transfers: { in: [50], out: [51] } }),
      mgr("2", "A", { transfers: { in: [50], out: [51] } }),
      mgr("3", "B", { chip: "wildcard", transfers: { in: [50, 51, 11], out: [1, 2, 3] } }),
      mgr("4", "B", { chip: "freehit", transfers: { in: [11], out: [10] } }),
      mgr("5", "B", { transfers: null }),
    ]),
    "all",
  );
  assert.deepEqual(stats.transfersIn.map((e) => [e.name, e.value]), [["Isak", 2]]);
  assert.deepEqual(stats.transfersOut.map((e) => [e.name, e.value]), [["Watkins", 2]]);
  assert.equal(stats.transferManagers, 2, "unknown transfers are not counted as 'none'");
  assert.deepEqual(stats.transferChipManagers.map((m) => m.note), ["WC", "FH"]);
});

test("effective ownership counts the multiplier, bench as zero", () => {
  const stats = aggregateGwStats(
    payload([mgr("1", "A"), mgr("2", "A", { chip: "3xc", picks: squad(10, 3) }), mgr("3", "A", { picks: squad(11) })]),
    "all",
    // Every filler pick is owned by all three, so Haaland (two owners) sits outside a top 5.
    50,
  );
  const haaland = stats.owned.find((e) => e.element === 10)!;
  assert.equal(haaland.value, 2);
  assert.equal(haaland.extra, "EO 167%", "(2 + 3) / 3 managers");
  const raya = stats.owned.find((e) => e.element === 1)!;
  assert.equal(raya.value, 3);
  assert.equal(raya.extra, "EO 100%");
});

test("top scorers are drawn from owned players only, with owner counts", () => {
  const stats = aggregateGwStats(payload([mgr("1", "A"), mgr("2", "B", { picks: squad(11) })]), "all");
  assert.equal(stats.topScorers[0].name, "Haaland");
  assert.equal(stats.topScorers[0].value, 13);
  assert.equal(stats.topScorers[0].extra, "1 own");
  assert.ok(!stats.topScorers.some((e) => e.name === "Isak"), "Isak is owned by nobody");
});

test("group scope narrows every list", () => {
  const p = payload([
    mgr("1", "A", { hits: 4 }),
    mgr("2", "B", { picks: squad(11), hits: 8, chip: "bboost" }),
  ]);
  const a = aggregateGwStats(p, "A");
  assert.equal(a.managerCount, 1);
  assert.equal(a.captained[0].name, "Haaland");
  assert.equal(a.hits.total, 4);
  assert.equal(a.fplChips.length, 0);

  const b = aggregateGwStats(p, "B");
  assert.equal(b.captained[0].name, "Salah");
  assert.deepEqual(b.fplChips.map((c) => [c.code, c.managers.length]), [["BB", 1]]);
  assert.equal(b.hits.takers[0].note, "−8");
});

test("top managers rank by net of hits; unknown gross is left out", () => {
  const stats = aggregateGwStats(
    payload([mgr("1", "A", { gross: 70, hits: 12 }), mgr("2", "A", { gross: 60 }), mgr("3", "A", { gross: null, picks: null })]),
    "all",
  );
  assert.deepEqual(stats.topManagers.map((m) => [m.fplId, m.net]), [["2", 60], ["1", 58]]);
  assert.equal(stats.managerCount, 2, "a manager without picks is not in the denominator");
});
