/**
 * Which comparison the Match Center opens on from the nav.
 *
 * A team opens on the fixture its dashboard shows — the gameweek after its latest scored fixture,
 * with itself on the left. A visitor opens on the first fixture of the gameweek the Fixtures page
 * would open on.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { teamFixtureGameweek } from "../../src/lib/gameweeks/default-gw";
import { pickDefaultMatchup, type MatchupFixture } from "../../src/lib/match-center/defaults";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

/** GW1 and GW2 deadlines have passed, GW3 is ahead. */
const DEADLINE: Record<number, number> = { 1: NOW - 240 * HOUR, 2: NOW - 30 * HOUR, 3: NOW + 140 * HOUR };

function fx(gw: number, home: string, away: string, opts: Partial<MatchupFixture> = {}): MatchupFixture {
  return { gw, deadline: DEADLINE[gw], homeTeamId: home, awayTeamId: away, group: "A", isChallenge: false, hasResult: false, ...opts };
}

/** Four teams, a round each gameweek; GW1 scored, GW2 being played. */
const SEASON: MatchupFixture[] = [
  fx(1, "t1", "t2", { hasResult: true }),
  fx(1, "t3", "t4", { hasResult: true }),
  fx(2, "t1", "t3"),
  fx(2, "t4", "t2"),
  fx(3, "t2", "t3"),
  fx(3, "t4", "t1"),
];

test("the dashboard's gameweek: the one after the team's latest scored fixture", () => {
  assert.equal(teamFixtureGameweek([]), 1);
  assert.equal(teamFixtureGameweek([{ gw: 1, scored: true }, { gw: 2, scored: false }]), 2);
  assert.equal(teamFixtureGameweek([{ gw: 1, scored: true }, { gw: 3, scored: true }, { gw: 2, scored: false }]), 4);
});

test("a team opens on its dashboard fixture, on the left even when it plays away", () => {
  assert.deepEqual(pickDefaultMatchup(SEASON, { team: "t2", now: NOW }), { gw: 2, a: "t2", b: "t4" });
  assert.deepEqual(pickDefaultMatchup(SEASON, { team: "t1", now: NOW }), { gw: 2, a: "t1", b: "t3" });
});

test("results drive it, not deadlines: GW2 scored early moves the team on to GW3", () => {
  const scored = SEASON.map((f) => (f.gw === 2 && f.homeTeamId === "t1" ? { ...f, hasResult: true } : f));
  assert.deepEqual(pickDefaultMatchup(scored, { team: "t1", now: NOW }), { gw: 3, a: "t1", b: "t4" });
});

test("a team with no fixture that gameweek (knocked out) opens on its last one", () => {
  const out = SEASON.filter((f) => !(f.gw >= 2 && (f.homeTeamId === "t2" || f.awayTeamId === "t2")));
  assert.deepEqual(pickDefaultMatchup(out, { team: "t2", now: NOW }), { gw: 1, a: "t2", b: "t1" });
});

test("a gameweek fixed in the URL is honoured for the team", () => {
  assert.deepEqual(pickDefaultMatchup(SEASON, { gw: 3, team: "t3", now: NOW }), { gw: 3, a: "t3", b: "t2" });
});

test("a visitor opens on the first fixture of the gameweek in flight, Group A first", () => {
  const grouped = [fx(2, "b1", "b2", { group: "B" }), ...SEASON];
  assert.deepEqual(pickDefaultMatchup(grouped, { now: NOW }), { gw: 2, a: "t1", b: "t3" });
});

test("a team with no fixtures at all gets the visitor's default", () => {
  assert.deepEqual(pickDefaultMatchup(SEASON, { team: "t9", now: NOW }), { gw: 2, a: "t1", b: "t3" });
});

test("no fixtures, nothing to open", () => {
  assert.equal(pickDefaultMatchup([], { team: "t1", now: NOW }), null);
});
