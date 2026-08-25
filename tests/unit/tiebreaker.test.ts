/**
 * Pure-function tests for the canonical league-stage tiebreaker.
 *
 * Run with: npm run test:unit
 *
 * `compareTiebreaker` is the single definition of standings order, shared by
 * /api/standings, TVT playoff seeding and the tentative-bracket preview. It
 * touches no DB and no network, so node:test drives it directly.
 *
 * The regression it exists to lock down: GW1 of TVT S7 had every winner level
 * on 2 pts / 1 W / 0 H2H / 0 CP/BP. The comparator stopped at tier 4, the sort
 * fell through to DB row order, and the table rendered alphabetically — Noob
 * Squad (215 FPL pts) sat 5 places below Alonso Poachers (214).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { compareTiebreaker, type TeamStanding } from "../../src/lib/formats/tvt/tiebreaker";

/** Build a standings row; every tiebreaker key defaults to "level with everyone". */
function team(teamId: string, over: Partial<TeamStanding> = {}): TeamStanding {
  return {
    teamId,
    leaguePoints: 0,
    wins: 0,
    headToHeadRecord: {},
    cbpPoints: 0,
    pointsFor: 0,
    ...over,
  };
}

const order = (ts: TeamStanding[]) => [...ts].sort(compareTiebreaker).map((t) => t.teamId);

test("tier 1: higher league points wins", () => {
  const a = team("a", { leaguePoints: 2, pointsFor: 100 });
  const b = team("b", { leaguePoints: 4, pointsFor: 100 });
  assert.deepEqual(order([a, b]), ["b", "a"]);
});

test("tier 2: level on points, more wins wins", () => {
  // 3 draws (3 pts) vs 1 win + 1 chip point (3 pts) — same total, different shape.
  const draws = team("draws", { leaguePoints: 3, wins: 0 });
  const wins = team("wins", { leaguePoints: 3, wins: 1 });
  assert.deepEqual(order([draws, wins]), ["wins", "draws"]);
});

test("tier 3: level on points and wins, head-to-head decides", () => {
  // "beat" won their meeting with "lost": 2 match points vs 0.
  const beat = team("beat", { leaguePoints: 6, wins: 3, headToHeadRecord: { lost: 2 } });
  const lost = team("lost", { leaguePoints: 6, wins: 3, headToHeadRecord: { beat: 0 } });
  assert.deepEqual(order([lost, beat]), ["beat", "lost"]);
});

test("tier 3: a drawn head-to-head does not decide, falls through", () => {
  const a = team("a", { leaguePoints: 6, wins: 3, headToHeadRecord: { b: 1 }, cbpPoints: 1 });
  const b = team("b", { leaguePoints: 6, wins: 3, headToHeadRecord: { a: 1 }, cbpPoints: 4 });
  assert.deepEqual(order([a, b]), ["b", "a"]);
});

test("tier 4: level through head-to-head, higher CP/BP wins", () => {
  const a = team("a", { leaguePoints: 6, wins: 3, cbpPoints: 2, pointsFor: 900 });
  const b = team("b", { leaguePoints: 6, wins: 3, cbpPoints: 5, pointsFor: 100 });
  assert.deepEqual(order([a, b]), ["b", "a"]);
});

test("tier 5: level through CP/BP, higher total FPL score wins", () => {
  const a = team("a", { leaguePoints: 2, wins: 1, cbpPoints: 0, pointsFor: 214 });
  const b = team("b", { leaguePoints: 2, wins: 1, cbpPoints: 0, pointsFor: 215 });
  assert.deepEqual(order([a, b]), ["b", "a"]);
});

test("CP/BP outranks total FPL score", () => {
  // Guards the tier 4/5 ordering specifically — swapping them flips this case.
  const chips = team("chips", { leaguePoints: 4, wins: 2, cbpPoints: 3, pointsFor: 150 });
  const scorer = team("scorer", { leaguePoints: 4, wins: 2, cbpPoints: 0, pointsFor: 300 });
  assert.deepEqual(order([chips, scorer]), ["chips", "scorer"]);
});

test("TVT S7 GW1 Group A: all winners level, ordered by total FPL score", () => {
  // Every team: 1 played, 1 won, 2 pts, no chips, no bonus. Winners never faced
  // each other, so every head-to-head key is absent. Only `pointsFor` separates
  // them — this is the exact shape that used to render alphabetically.
  const winners: [string, number][] = [
    ["Alonso Poachers", 214],
    ["Dark Knights", 183],
    ["Dracarys", 193],
    ["Guns n Blues", 194],
    ["NH-HILLIBILIES", 193],
    ["Noob Squad", 215],
    ["Pakhala Army", 190],
    ["Stretford Kops", 202],
  ];
  const losers: [string, number][] = [
    ["Ballbreakers", 161],
    ["Blaugrana Cules", 182],
    ["Differential Disaster", 138],
    ["Jama Juggernauts", 182],
    ["Peaky Blinders", 134],
    ["Scouse Force", 158],
    ["Team Rocket", 119],
    ["The Anfield Devils", 185],
  ];

  const rows = [
    ...winners.map(([n, pf]) => team(n, { leaguePoints: 2, wins: 1, pointsFor: pf })),
    ...losers.map(([n, pf]) => team(n, { leaguePoints: 0, wins: 0, pointsFor: pf })),
  ];

  assert.deepEqual(order(rows), [
    // Winners, by FPL score descending.
    "Noob Squad",        // 215
    "Alonso Poachers",   // 214
    "Stretford Kops",    // 202
    "Guns n Blues",      // 194
    "Dracarys",          // 193
    "NH-HILLIBILIES",    // 193 — level, so input order holds (stable sort)
    "Pakhala Army",      // 190
    "Dark Knights",      // 183
    // Losers never rise above a winner: tier 1 settles it before FPL score is read,
    // so The Anfield Devils (185) stays 9th despite outscoring Dark Knights (183).
    "The Anfield Devils",
    "Blaugrana Cules",
    "Jama Juggernauts",
    "Ballbreakers",
    "Scouse Force",
    "Differential Disaster",
    "Peaky Blinders",
    "Team Rocket",
  ]);
});

test("fully level teams compare equal (stable, no phantom ordering)", () => {
  const a = team("a", { leaguePoints: 4, wins: 2, cbpPoints: 1, pointsFor: 200 });
  const b = team("b", { leaguePoints: 4, wins: 2, cbpPoints: 1, pointsFor: 200 });
  assert.equal(compareTiebreaker(a, b), 0);
  assert.equal(compareTiebreaker(b, a), 0);
});
