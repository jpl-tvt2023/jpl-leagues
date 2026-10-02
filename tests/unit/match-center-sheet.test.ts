/**
 * The Match Center's merged team sheet: one row per PL player per JPL team, with the multiplier
 * his points carry into the JPL score.
 *
 * The property everything here protects: rows × points must add up to the managers' gross
 * scores, and the JPL captain's doubling must land on the right players. A page that shows
 * Haaland ×4 while the scoreline beside it counted him ×6 is worse than no page.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTeamSheet,
  compareSheets,
  projectAutoSubs,
  type ClubMeta,
  type ElementMeta,
  type SheetFixture,
  type SheetManagerInput,
} from "../../src/lib/match-center/team-sheet";
import type { FPLGameweekPicks } from "../../src/lib/fpl";
import type { CachedElementDetail } from "../../src/lib/fpl-cache";

const NOW = Date.parse("2026-10-03T18:00:00Z");

// Clubs 1 v 2 have finished; 3 v 4 kick off tomorrow.
const CLUBS = new Map<number, ClubMeta>(
  [1, 2, 3, 4].map((id) => [id, { id, short: `C${id}`, name: `Club ${id}` }]),
);
const FIXTURES: SheetFixture[] = [
  { id: 1, kickoff_time: "2026-10-03T14:00:00Z", team_h: 1, team_a: 2, team_h_score: 2, team_a_score: 1, finished: false, finished_provisional: true },
  { id: 2, kickoff_time: "2026-10-04T14:00:00Z", team_h: 3, team_a: 4, team_h_score: null, team_a_score: null, finished: false, finished_provisional: false },
];

/** element id -> [position, club] */
const ELEMENT_SPECS: Record<number, [number, number]> = {
  1: [1, 1], // GK, finished
  2: [2, 1], 3: [2, 2], 4: [2, 3],
  5: [3, 1], 6: [3, 2], 7: [3, 3], 8: [3, 4],
  9: [4, 1], 10: [4, 3], 11: [4, 4],
  12: [1, 2], // bench GK
  13: [3, 2], // bench MID, played
  14: [2, 2], // bench DEF, played
  15: [4, 4], // bench FWD, yet to play
  20: [4, 1], // "Haaland"
};
const ELEMENTS = new Map<number, ElementMeta>(
  Object.entries(ELEMENT_SPECS).map(([id, [position, clubId]]) => [
    Number(id),
    { id: Number(id), name: `P${id}`, position, clubId },
  ]),
);

function detail(map: Record<number, [number, number]>): Record<number, CachedElementDetail> {
  return Object.fromEntries(Object.entries(map).map(([id, [p, m]]) => [id, { p, m, b: [] }]));
}

type PickSpec = [element: number, multiplier: number, flags?: "C" | "VC"];

function picks(specs: PickSpec[], opts: { settledPoints?: number; hits?: number; chip?: string | null; autoSubs?: { element_in: number; element_out: number }[] } = {}): FPLGameweekPicks {
  return {
    active_chip: opts.chip ?? null,
    automatic_subs: opts.autoSubs ?? [],
    entry_history: {
      event: 7,
      points: opts.settledPoints ?? 0,
      total_points: 0,
      rank: null,
      event_transfers: 0,
      event_transfers_cost: opts.hits ?? 0,
    },
    picks: specs.map(([element, multiplier, flag], i) => ({
      element,
      position: i + 1,
      multiplier,
      is_captain: flag === "C",
      is_vice_captain: flag === "VC",
    })),
  };
}

function manager(id: string, p: FPLGameweekPicks | null, jplCaptain = false): SheetManagerInput {
  return { playerId: id, name: `Manager ${id}`, fplId: id, isJplCaptain: jplCaptain, isTempCaptain: false, picks: p };
}

/** A legal 15: GK, 3 DEF, 4 MID, 3 FWD, then bench GK/MID/DEF/FWD. Captain on element 20. */
function standardSquad(captain = 20, mult = 2): PickSpec[] {
  return [
    [1, 1], [2, 1], [3, 1], [4, 1],
    [5, 1, "VC"], [6, 1], [7, 1], [8, 1],
    [captain, mult, "C"], [10, 1], [11, 1],
    [12, 0], [13, 0], [14, 0], [15, 0],
  ];
}

test("both managers captain the same player, one is JPL captain: x6", () => {
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(standardSquad()), true), manager("B", picks(standardSquad()))],
    settled: false,
    detail: detail({ 20: [10, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  const haaland = sheet.rows.find((r) => r.element === 20)!;
  assert.equal(haaland.multiplier, 6, "2x2 for the JPL captain's armband + 2x1");
  assert.equal(haaland.contribution, 60);
  assert.deepEqual(haaland.owners.map((o) => [o.fplId, o.role, o.effective]), [["A", "C", 4], ["B", "C", 2]]);
  assert.equal(sheet.total, 60, "rows reconcile to the team total");
});

test("Triple Captain by the JPL captain plus a normal captain: x8", () => {
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(standardSquad(20, 3), { chip: "3xc" }), true), manager("B", picks(standardSquad()))],
    settled: false,
    detail: detail({ 20: [5, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  const row = sheet.rows.find((r) => r.element === 20)!;
  assert.equal(row.multiplier, 8);
  assert.equal(row.owners[0].role, "TC");
  assert.equal(sheet.managers[0].chip, "3xc");
});

test("hits come off the manager, before the JPL doubling", () => {
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(standardSquad(), { hits: 4 }), true), manager("B", picks(standardSquad(), { hits: 8 }))],
    settled: false,
    detail: detail({ 20: [10, 90], 2: [6, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  const [a, b] = sheet.managers;
  assert.equal(a.gross, 26, "6 + 10x2");
  assert.equal(a.final, (26 - 4) * 2);
  assert.equal(b.final, 26 - 8);
  assert.equal(sheet.total, 44 + 18);
});

test("benched by both is the bench at x0; started by one is in the XI", () => {
  const bSquad = standardSquad();
  bSquad[12] = [2, 0]; // B benches element 2, which A starts
  bSquad[1] = [14, 1];
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(standardSquad())), manager("B", picks(bSquad))],
    settled: false,
    detail: detail({}),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  const el2 = sheet.rows.find((r) => r.element === 2)!;
  assert.deepEqual(el2.owners.map((o) => o.role), ["XI", "BENCH"]);
  assert.equal(el2.multiplier, 1);
  assert.ok(sheet.bench.some((r) => r.element === 12 && r.multiplier === 0), "both bench GKs on the bench");
  assert.ok(!sheet.bench.some((r) => r.element === 2));
});

test("live: captain blanked with nothing left to play hands the armband to the vice", () => {
  // Captain is element 9 (club 1, finished) with 0 minutes; vice is element 5.
  const squad = standardSquad();
  squad[8] = [9, 2, "C"];
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(squad), true)],
    settled: false,
    detail: detail({ 5: [7, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  const vice = sheet.rows.find((r) => r.element === 5)!;
  assert.equal(vice.owners[0].fplMultiplier, 2);
  assert.equal(vice.owners[0].armbandInherited, true);
  assert.equal(vice.multiplier, 4, "and the JPL doubling stacks on top");
  assert.equal(sheet.rows.find((r) => r.element === 9)!.multiplier, 0);
});

test("live: a captain yet to kick off keeps the armband", () => {
  // Captain element 10 is club 3, which plays tomorrow.
  const squad = standardSquad();
  squad[8] = [10, 2, "C"];
  squad[9] = [20, 1];
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(squad))],
    settled: false,
    detail: detail({ 5: [7, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  assert.equal(sheet.rows.find((r) => r.element === 10)!.multiplier, 2);
  assert.equal(sheet.rows.find((r) => r.element === 5)!.multiplier, 1);
  assert.equal(sheet.rows.find((r) => r.element === 10)!.leftToPlay, 1);
  assert.equal(sheet.rows.find((r) => r.element === 10)!.matches[0].state, "upcoming");
});

test("auto-sub projection keeps the formation: a DEF out with 3 DEF can only bring a DEF on", () => {
  // Element 2 (DEF, club 1 finished) did not play. Bench: GK 12, MID 13 (played), DEF 14 (played).
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(standardSquad()))],
    settled: false,
    detail: detail({ 13: [3, 90], 14: [2, 90], 20: [8, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  const a = sheet.managers[0];
  const subFor2 = a.projectedSubs.find((s) => s.out === 2);
  assert.deepEqual(subFor2, { out: 2, in: 14 }, "MID 13 is first on the bench but would leave 2 DEF");
  assert.equal(sheet.rows.find((r) => r.element === 2)!.owners[0].projectedSubOut, true);
  assert.equal(sheet.bench.find((r) => r.element === 14)!.owners[0].projectedSubIn, true);
  assert.equal(sheet.rows.find((r) => r.element === 2)!.multiplier, 1, "projection never changes the multiplier");
});

test("auto-sub projection: GK only for GK, and only a bench player who has played", () => {
  const resolved = picks(standardSquad()).picks.map((p) => ({
    element: p.element, position: p.position, pickMultiplier: p.multiplier, multiplier: p.multiplier,
    is_captain: p.is_captain, is_vice_captain: p.is_vice_captain,
  }));
  const minutes: Record<number, number> = { 12: 0, 13: 90 };
  const subs = projectAutoSubs(
    resolved,
    (el) => minutes[el] ?? (el === 1 ? 0 : 90),
    (el) => ELEMENTS.get(el)!.position,
    () => true,
  );
  assert.deepEqual(subs, [{ out: 1, in: null }], "the bench GK has not played, so nobody can replace the GK");
});

test("Bench Boost: no projection, every bench player already counts", () => {
  const squad = standardSquad().map(([el, m, f], i): PickSpec => [el, i >= 11 ? 1 : m, f]);
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(squad, { chip: "bboost" }))],
    settled: false,
    detail: detail({ 13: [3, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  assert.deepEqual(sheet.managers[0].projectedSubs, []);
  assert.equal(sheet.bench.length, 0, "Bench Boost puts all fifteen in the XI section");
});

test("settled: FPL's automatic_subs are applied and any remaining gap is reported", () => {
  // Element 2 subbed off for 14. FPL settled the manager on 30; the rows add up to 28.
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(standardSquad(), { settledPoints: 30, autoSubs: [{ element_in: 14, element_out: 2 }] }))],
    settled: true,
    detail: detail({ 14: [4, 90], 20: [12, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  const inRow = sheet.rows.find((r) => r.element === 14)!;
  assert.equal(inRow.owners[0].autoSubIn, true);
  assert.equal(inRow.multiplier, 1);
  assert.equal(sheet.rows.find((r) => r.element === 2)!.owners[0].autoSubOut, true);
  assert.equal(sheet.managers[0].gross, 30, "settled gross is FPL's own number");
  assert.equal(sheet.managers[0].fplAdjustment, 30 - (4 + 24));
  assert.deepEqual(sheet.managers[0].projectedSubs, [], "no projection once settled");
});

test("a manager whose picks failed to load is flagged, not zero-filled silently", () => {
  const sheet = buildTeamSheet({
    managers: [manager("A", picks(standardSquad())), manager("B", null)],
    settled: false,
    detail: detail({ 20: [5, 90] }),
    elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
  });
  assert.equal(sheet.managers[1].unavailable, true);
  assert.equal(sheet.rows.find((r) => r.element === 20)!.multiplier, 2);
});

test("compareSheets: common players only cancel when the multipliers match", () => {
  const build = (cap: number, jpl: boolean) =>
    buildTeamSheet({
      managers: [manager("X", picks(standardSquad(cap)), jpl)],
      settled: false,
      detail: detail({ 20: [10, 90], 10: [6, 90] }),
      elements: ELEMENTS, clubs: CLUBS, gwFixtures: FIXTURES, now: NOW,
    });
  const a = build(20, true); // Haaland x4
  const b = build(20, false); // Haaland x2
  const cmp = compareSheets(a, b);
  assert.deepEqual(cmp.byElement[20], { a: 4, b: 2, common: true });
  assert.equal(cmp.aEdges[0].element, 20);
  assert.equal(cmp.aEdges[0].swing, 20, "10 points x a two-multiplier edge");
  assert.deepEqual(cmp.byElement[10], { a: 2, b: 1, common: true }, "A's JPL doubling covers every starter");
  assert.deepEqual(
    cmp.aEdges.slice(0, 2).map((e) => [e.element, e.swing]),
    [[20, 20], [10, 6]],
    "edges ordered by points swing",
  );
  assert.equal(cmp.bEdges.length, 0, "B never out-multiplies A on an identical squad");
});
