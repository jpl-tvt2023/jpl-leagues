/**
 * Gameweek awards: match points, chips, and the per-group 75+ bonus.
 *
 * The assertion that matters most here is "a gameweek split across two passes awards the same
 * single bonus as one pass". The processor skips fixtures that already have a result and used
 * to collect bonus margins only from the batch in front of it, so a gameweek processed in two
 * goes handed the group bonus to two different teams. An automatic daily run turns that from a
 * rare accident into the normal path, which is why this function takes the whole gameweek.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  computeGameweekAwards,
  type AwardChipInput,
  type AwardFixtureInput,
} from "../../src/lib/formats/tvt/gameweek-awards";

function fixture(over: Partial<AwardFixtureInput> & { fixtureId: string }): AwardFixtureInput {
  return {
    groupId: "A",
    homeTeamId: `${over.fixtureId}-home`,
    awayTeamId: `${over.fixtureId}-away`,
    homeScore: 0,
    awayScore: 0,
    homeHits: 0,
    awayHits: 0,
    ...over,
  };
}

function chip(teamId: string, chipType: string, over: Partial<AwardChipInput> = {}): AwardChipInput {
  return { chipId: `${teamId}-${chipType}`, teamId, chipType, wastedReason: null, ...over };
}

test("a win is 2, a draw is 1, a loss is 0", () => {
  const { byTeam } = computeGameweekAwards({
    fixtures: [
      fixture({ fixtureId: "f1", homeScore: 80, awayScore: 60 }),
      fixture({ fixtureId: "f2", homeScore: 55, awayScore: 55 }),
    ],
    chips: [],
  });

  assert.equal(byTeam.get("f1-home")!.matchPoints, 2);
  assert.equal(byTeam.get("f1-away")!.matchPoints, 0);
  assert.equal(byTeam.get("f2-home")!.matchPoints, 1);
  assert.equal(byTeam.get("f2-away")!.matchPoints, 1);
});

test("Win-Win forces 2 points off a loss, and banks only the extra", () => {
  const { byTeam, chips } = computeGameweekAwards({
    fixtures: [fixture({ fixtureId: "f1", homeScore: 40, awayScore: 90 })],
    chips: [chip("f1-home", "W")],
  });

  assert.equal(byTeam.get("f1-home")!.matchPoints, 2);
  // EXTRA only: 2 awarded minus the 0 they would have earned.
  assert.equal(chips.find((c) => c.teamId === "f1-home")!.pointsAwarded, 2);
});

test("Win-Win is void for a side that took any transfer hit", () => {
  const { byTeam, chips } = computeGameweekAwards({
    fixtures: [fixture({ fixtureId: "f1", homeScore: 40, awayScore: 90, homeHits: 4 })],
    chips: [chip("f1-home", "W")],
  });

  assert.equal(byTeam.get("f1-home")!.matchPoints, 0, "keeps the natural result");
  const spent = chips.find((c) => c.teamId === "f1-home")!;
  assert.equal(spent.pointsAwarded, 0);
  assert.equal(spent.hadNegativeHits, true, "the chip is spent, not returned");
});

test("Double Pointer doubles the match points", () => {
  const { byTeam, chips } = computeGameweekAwards({
    fixtures: [fixture({ fixtureId: "f1", homeScore: 90, awayScore: 40 })],
    chips: [chip("f1-home", "D")],
  });

  assert.equal(byTeam.get("f1-home")!.matchPoints, 4);
  assert.equal(byTeam.get("f1-home")!.usedDoublePointer, true);
  assert.equal(chips.find((c) => c.teamId === "f1-home")!.pointsAwarded, 2);
});

test("a chip lost to an FPL clash is spent and changes nothing", () => {
  const { byTeam, chips } = computeGameweekAwards({
    fixtures: [fixture({ fixtureId: "f1", homeScore: 40, awayScore: 90 })],
    chips: [chip("f1-home", "W", { wastedReason: "fpl-chip-clash" })],
  });

  assert.equal(byTeam.get("f1-home")!.matchPoints, 0);
  const wasted = chips.find((c) => c.teamId === "f1-home")!;
  assert.equal(wasted.pointsAwarded, 0);
  assert.equal(wasted.wastedReason, "fpl-chip-clash");
});

test("the 75+ bonus goes to the single largest margin in the group", () => {
  const { byTeam } = computeGameweekAwards({
    fixtures: [
      fixture({ fixtureId: "f1", homeScore: 180, awayScore: 100 }), // margin 80
      fixture({ fixtureId: "f2", homeScore: 200, awayScore: 100 }), // margin 100 — winner
      fixture({ fixtureId: "f3", homeScore: 130, awayScore: 120 }), // margin 10
    ],
    chips: [],
  });

  assert.equal(byTeam.get("f2-home")!.gotBonus, true);
  assert.equal(byTeam.get("f2-home")!.bonusPoints, 1);
  assert.equal(byTeam.get("f2-home")!.leaguePoints, 3);
  assert.equal(byTeam.get("f1-home")!.gotBonus, false, "80 is 75+ but not the largest");
  assert.equal(byTeam.get("f3-home")!.gotBonus, false);
});

test("tied largest margins share the bonus", () => {
  const { byTeam } = computeGameweekAwards({
    fixtures: [
      fixture({ fixtureId: "f1", homeScore: 180, awayScore: 100 }),
      fixture({ fixtureId: "f2", homeScore: 190, awayScore: 110 }),
    ],
    chips: [],
  });

  assert.equal(byTeam.get("f1-home")!.gotBonus, true);
  assert.equal(byTeam.get("f2-home")!.gotBonus, true);
});

test("a Double Pointer bonus winner gets 2 bonus points, not 1", () => {
  const { byTeam } = computeGameweekAwards({
    fixtures: [fixture({ fixtureId: "f1", homeScore: 200, awayScore: 100 })],
    chips: [chip("f1-home", "D")],
  });

  const award = byTeam.get("f1-home")!;
  assert.equal(award.bonusPoints, 2);
  // (2 + 1) x 2 = 6 for the gameweek.
  assert.equal(award.leaguePoints, 6);
});

test("no 75+ margin in a group awards no bonus at all", () => {
  const { byTeam } = computeGameweekAwards({
    fixtures: [fixture({ fixtureId: "f1", homeScore: 130, awayScore: 120 })],
    chips: [],
  });

  assert.equal(byTeam.get("f1-home")!.gotBonus, false);
  assert.equal(byTeam.get("f1-home")!.leaguePoints, 2);
});

test("the bonus is scoped to its own group", () => {
  const { byTeam } = computeGameweekAwards({
    fixtures: [
      fixture({ fixtureId: "f1", groupId: "A", homeScore: 200, awayScore: 100 }),
      fixture({ fixtureId: "f2", groupId: "B", homeScore: 180, awayScore: 100 }),
    ],
    chips: [],
  });

  assert.equal(byTeam.get("f1-home")!.gotBonus, true, "largest in A");
  assert.equal(byTeam.get("f2-home")!.gotBonus, true, "largest in B, despite a smaller margin");
});

test("a groupless fixture never competes for the bonus", () => {
  const { byTeam } = computeGameweekAwards({
    fixtures: [fixture({ fixtureId: "f1", groupId: null, homeScore: 200, awayScore: 100 })],
    chips: [],
  });

  assert.equal(byTeam.get("f1-home")!.gotBonus, false);
});

test("a gameweek split across two passes awards the same single bonus as one pass", () => {
  // The regression. Processing f1 alone hands it the bonus on margin 80; processing f2 alone
  // hands it the bonus on margin 100. Run over the whole gameweek, only f2 can have it — and
  // that must hold however the work was split.
  const all = [
    fixture({ fixtureId: "f1", homeScore: 180, awayScore: 100 }),
    fixture({ fixtureId: "f2", homeScore: 200, awayScore: 100 }),
  ];

  const whole = computeGameweekAwards({ fixtures: all, chips: [] });

  // What the old per-batch behaviour would have produced, made explicit.
  const firstBatch = computeGameweekAwards({ fixtures: [all[0]], chips: [] });
  const secondBatch = computeGameweekAwards({ fixtures: [all[1]], chips: [] });
  assert.equal(
    firstBatch.byTeam.get("f1-home")!.gotBonus && secondBatch.byTeam.get("f2-home")!.gotBonus,
    true,
    "per-batch scoring would award the group bonus twice — the bug this guards",
  );

  assert.equal(whole.byTeam.get("f2-home")!.gotBonus, true);
  assert.equal(whole.byTeam.get("f1-home")!.gotBonus, false);
  const winners = [...whole.byTeam.values()].filter((a) => a.gotBonus);
  assert.equal(winners.length, 1, "exactly one bonus for the group, whatever the split");
});

test("a fixture settled on an earlier pass still competes for the bonus", () => {
  // How the processor folds in work it already did: f1 has a result row, so no chips are passed
  // for it, but its margin must still be weighed — otherwise the second pass hands f2 a bonus
  // that belongs to f1.
  const { byTeam } = computeGameweekAwards({
    fixtures: [
      fixture({ fixtureId: "f1", homeScore: 220, awayScore: 100 }), // settled, margin 120
      fixture({ fixtureId: "f2", homeScore: 200, awayScore: 100 }), // new, margin 100
    ],
    chips: [],
  });

  assert.equal(byTeam.get("f1-home")!.gotBonus, true);
  assert.equal(byTeam.get("f2-home")!.gotBonus, false, "the new fixture does not win it by default");
});

test("a settled fixture's recorded Double Pointer still doubles its bonus", () => {
  const { byTeam } = computeGameweekAwards({
    fixtures: [
      fixture({ fixtureId: "f1", homeScore: 220, awayScore: 100, homeUsedDoublePointer: true }),
    ],
    chips: [], // already processed, so none supplied
  });

  const award = byTeam.get("f1-home")!;
  assert.equal(award.usedDoublePointer, true);
  assert.equal(award.bonusPoints, 2, "taken from the result row, not re-derived from chips");
});

test("running the same gameweek twice returns identical awards", () => {
  const fixtures = [
    fixture({ fixtureId: "f1", homeScore: 180, awayScore: 100 }),
    fixture({ fixtureId: "f2", homeScore: 120, awayScore: 120, homeHits: 8 }),
  ];
  const chips = [chip("f1-home", "D"), chip("f2-home", "W")];

  const a = computeGameweekAwards({ fixtures, chips });
  const b = computeGameweekAwards({ fixtures, chips });

  assert.deepEqual([...a.byTeam.entries()], [...b.byTeam.entries()]);
  assert.deepEqual(a.chips, b.chips);
});

test("an empty gameweek yields no awards rather than throwing", () => {
  const { byTeam, chips } = computeGameweekAwards({ fixtures: [], chips: [] });
  assert.equal(byTeam.size, 0);
  assert.equal(chips.length, 0);
});
