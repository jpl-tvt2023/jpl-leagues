/**
 * Folding an in-progress gameweek into the settled league table.
 *
 * The load-bearing assertions here are the ones about NOT counting things twice — a fixture
 * that already has a result must not be folded in, and the caller's rows must come back
 * unmutated — and the one about head-to-head, which is the tiebreaker tier most easily left
 * pretending the live gameweek has not happened.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { applyLiveFixtures, type LiveFixtureLike } from "../../src/lib/standings/live-overlay";
import type { LeagueStageRow } from "../../src/lib/standings/league-stage";
import type { TeamAward } from "../../src/lib/formats/tvt/gameweek-awards";

function row(teamId: string, over: Partial<LeagueStageRow> = {}): LeagueStageRow {
  return {
    teamId,
    name: teamId,
    group: "A",
    played: 3,
    wins: 1,
    draws: 1,
    losses: 1,
    pointsFor: 300,
    pointsAgainst: 300,
    pointsDiff: 0,
    leaguePoints: 3,
    bonusPoints: 0,
    chipPoints: 0,
    cbpPoints: 0,
    headToHeadRecord: {},
    bpsEntries: [],
    hitPenaltyGws: [],
    hitPenaltyTotal: 0,
    rawChips: [],
    players: [],
    groupRank: 0,
    zone: "eliminated",
    ...over,
  };
}

function award(teamId: string, over: Partial<TeamAward> = {}): TeamAward {
  return {
    teamId,
    fixtureId: "f1",
    naturalMatchPoints: 0,
    matchPoints: 0,
    usedDoublePointer: false,
    gotBonus: false,
    bonusPoints: 0,
    leaguePoints: 0,
    ...over,
  };
}

const fixture = (over: Partial<LiveFixtureLike> = {}): LiveFixtureLike => ({
  fixtureId: "f1",
  homeTeamId: "home",
  awayTeamId: "away",
  homeScore: 0,
  awayScore: 0,
  ...over,
});

const byId = (rows: LeagueStageRow[], id: string) => rows.find((r) => r.teamId === id)!;

test("a live win moves the winner two points and the loser none", () => {
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [fixture({ homeScore: 120, awayScore: 90 })],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  assert.equal(byId(out, "home").leaguePoints, 5);
  assert.equal(byId(out, "home").wins, 2);
  assert.equal(byId(out, "away").leaguePoints, 3);
  assert.equal(byId(out, "away").losses, 2);
});

test("a live draw moves both by one", () => {
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [fixture({ homeScore: 100, awayScore: 100 })],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  assert.equal(byId(out, "home").leaguePoints, 4);
  assert.equal(byId(out, "away").leaguePoints, 4);
  assert.equal(byId(out, "home").draws, 2);
});

test("played, points for/against and goal difference all move", () => {
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [fixture({ homeScore: 120, awayScore: 90 })],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  const home = byId(out, "home");
  assert.equal(home.played, 4);
  assert.equal(home.pointsFor, 420);
  assert.equal(home.pointsAgainst, 390);
  assert.equal(home.pointsDiff, 30);
});

test("head-to-head records the live result, so tier 3 can separate two level teams", () => {
  // Level on league points and wins after the live gameweek; only the head-to-head they just
  // played can split them. If the overlay skipped it, the pair would stay tied.
  const out = applyLiveFixtures(
    [
      row("home", { leaguePoints: 3, wins: 1 }),
      row("away", { leaguePoints: 5, wins: 2 }),
    ],
    [fixture({ homeScore: 120, awayScore: 90 })],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  assert.equal(byId(out, "home").headToHeadRecord["away"], 2);
  assert.equal(byId(out, "away").headToHeadRecord["home"], 0);
  // home now leads on the head-to-head, both being level on 5 points and 2 wins.
  assert.equal(out[0].teamId, "home");
});

test("chip points land in both cbpPoints and leaguePoints, counted as the extra only", () => {
  // Win-Win on a loss: 2 points awarded, 0 earned naturally, so the extra is 2.
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [fixture({ homeScore: 80, awayScore: 150 })],
    new Map([["home", award("home", { naturalMatchPoints: 0, matchPoints: 2 })]]),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  const home = byId(out, "home");
  assert.equal(home.chipPoints, 2);
  assert.equal(home.cbpPoints, 2);
  assert.equal(home.leaguePoints, 5, "3 settled + 0 natural + 2 chip");
  assert.equal(home.losses, 2, "the chip does not turn a defeat into a win");
});

test("a live 75+ bonus is included, and a Double Pointer one counts double", () => {
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [fixture({ homeScore: 200, awayScore: 100 })],
    new Map([
      [
        "home",
        award("home", {
          naturalMatchPoints: 2,
          matchPoints: 4,
          usedDoublePointer: true,
          gotBonus: true,
          bonusPoints: 2,
        }),
      ],
    ]),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  const home = byId(out, "home");
  assert.equal(home.cbpPoints, 4, "2 chip extra + 2 bonus");
  assert.equal(home.leaguePoints, 9, "3 settled + 2 natural + 2 chip + 2 bonus");
});

test("a player over twelve live hits costs a league point", () => {
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [
      fixture({
        homeScore: 120,
        awayScore: 90,
        homePlayers: [{ name: "Over", transferHits: 16 }, { name: "Fine", transferHits: 8 }],
      }),
    ],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  const home = byId(out, "home");
  assert.equal(home.hitPenaltyTotal, 1);
  assert.equal(home.hitPenaltyGws[0].gameweek, 4);
  assert.equal(home.leaguePoints, 4, "3 settled + 2 for the win - 1 penalty");
});

test("two offenders in the same gameweek cost two points, not one", () => {
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [
      fixture({
        homeScore: 120,
        awayScore: 90,
        homePlayers: [{ transferHits: 16 }, { transferHits: 20 }],
      }),
    ],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  assert.equal(byId(out, "home").hitPenaltyTotal, 2);
});

test("exactly twelve hits is not over the threshold", () => {
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [fixture({ homeScore: 120, awayScore: 90, homePlayers: [{ transferHits: 12 }] })],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  assert.equal(byId(out, "home").hitPenaltyTotal, 0);
});

test("an empty live list returns the table untouched", () => {
  const settled = [row("home"), row("away")];
  const out = applyLiveFixtures(settled, [], new Map(), { gameweek: 4, leagueFormat: "tvt" });

  assert.deepEqual(out, settled);
});

test("the caller's rows are never mutated", () => {
  // The settled rows can come straight out of a cache, shared with other readers.
  const settled = [row("home"), row("away")];
  const before = JSON.parse(JSON.stringify(settled));

  applyLiveFixtures(
    settled,
    [fixture({ homeScore: 120, awayScore: 90, homePlayers: [{ transferHits: 16 }] })],
    new Map([["home", award("home", { naturalMatchPoints: 2, matchPoints: 4 })]]),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(settled)), before);
});

test("a fixture whose side is missing from the table is skipped whole", () => {
  // Never credit one half of a fixture: a ghost team or another league's fixture must not
  // silently hand its opponent two points.
  const out = applyLiveFixtures(
    [row("home")],
    [fixture({ homeScore: 120, awayScore: 90 })],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  assert.equal(byId(out, "home").played, 3, "unchanged");
  assert.equal(byId(out, "home").leaguePoints, 3);
});

test("the result is ordered by the shared tiebreaker, not by points alone", () => {
  // Level on 5 points after the live gameweek. Tier 2 is wins, and "wins" prefers the team
  // with two wins over the one with one win and two draws — which points-only ordering,
  // or leaving the order alone, would both get wrong.
  const out = applyLiveFixtures(
    [
      row("fewerWins", { leaguePoints: 4, wins: 1, draws: 2, played: 3 }),
      row("moreWins", { leaguePoints: 3, wins: 1, draws: 1, played: 3 }),
    ],
    [
      fixture({
        fixtureId: "f2",
        homeTeamId: "moreWins",
        awayTeamId: "fewerWins",
        homeScore: 150,
        awayScore: 100,
      }),
    ],
    new Map(),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  assert.equal(byId(out, "moreWins").leaguePoints, 5);
  assert.equal(byId(out, "fewerWins").leaguePoints, 4);
  assert.equal(out[0].teamId, "moreWins");
});

test("a Continental Championship table takes natural points only", () => {
  // CC's processor writes homeGotBonus:false on every result and has no awarding logic at all,
  // and league-stage skips hit penalties for it. Crediting a chip, a 75+ bonus or a penalty here
  // would invent points its settled table never gives.
  const out = applyLiveFixtures(
    [row("home"), row("away")],
    [
      fixture({
        homeScore: 200,
        awayScore: 100,
        homePlayers: [{ transferHits: 16 }],
      }),
    ],
    new Map([
      [
        "home",
        award("home", {
          naturalMatchPoints: 2,
          matchPoints: 4,
          gotBonus: true,
          bonusPoints: 1,
        }),
      ],
    ]),
    { gameweek: 4, leagueFormat: "continental-championship" },
  );

  const home = byId(out, "home");
  assert.equal(home.leaguePoints, 5, "3 settled + 2 for the win, and nothing else");
  assert.equal(home.cbpPoints, 0, "no chip extra, no bonus");
  assert.equal(home.hitPenaltyTotal, 0, "CC does not apply hit penalties");
  assert.equal(home.bpsEntries.length, 0);
});

test("a live fixture takes the bonus off a team whose own fixture settled earlier", () => {
  // The gameweek was processed in halves: `settled` already holds this gameweek's bonus from the
  // first pass. A live fixture in the same group now posts a bigger margin, so the awards give it
  // to `live` — and `settled` must LOSE it rather than both showing one.
  const out = applyLiveFixtures(
    [
      row("settled", { leaguePoints: 6, cbpPoints: 1, bpsEntries: [{ gameweek: 4, points: 1 }] }),
      row("live"),
      row("liveOpp"),
    ],
    [
      fixture({
        fixtureId: "f2",
        homeTeamId: "live",
        awayTeamId: "liveOpp",
        homeScore: 250,
        awayScore: 100,
      }),
    ],
    // Awards were computed over every fixture in the group, so they already name the new winner.
    new Map([
      ["live", award("live", { fixtureId: "f2", naturalMatchPoints: 2, matchPoints: 2, gotBonus: true, bonusPoints: 1 })],
      ["liveOpp", award("liveOpp", { fixtureId: "f2" })],
    ]),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  const settled = byId(out, "settled");
  assert.equal(settled.cbpPoints, 0, "bonus taken back");
  assert.equal(settled.leaguePoints, 5, "6 - 1");
  assert.equal(settled.bpsEntries.length, 0, "and the tooltip agrees");

  const live = byId(out, "live");
  assert.equal(live.cbpPoints, 1);
  assert.equal(live.leaguePoints, 6, "3 settled + 2 win + 1 bonus");

  const holders = out.filter((r) => r.bpsEntries.some((e) => e.gameweek === 4));
  assert.equal(holders.length, 1, "exactly one team holds the group's bonus");
});

test("a settled bonus that survives the live gameweek is left exactly where it is", () => {
  const out = applyLiveFixtures(
    [
      row("settled", { leaguePoints: 6, cbpPoints: 1, bpsEntries: [{ gameweek: 4, points: 1 }] }),
      row("live"),
      row("liveOpp"),
    ],
    [
      fixture({
        fixtureId: "f2",
        homeTeamId: "live",
        awayTeamId: "liveOpp",
        homeScore: 120,
        awayScore: 100,
      }),
    ],
    new Map([["settled", award("settled", { gotBonus: true, bonusPoints: 1 })]]),
    { gameweek: 4, leagueFormat: "tvt" },
  );

  const settled = byId(out, "settled");
  assert.equal(settled.cbpPoints, 1, "unchanged — no double credit on a no-op reconcile");
  assert.equal(settled.leaguePoints, 6);
  assert.equal(settled.bpsEntries.length, 1);
});
