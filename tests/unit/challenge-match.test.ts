/**
 * TVT Challenge Chip match derivation.
 *
 * The Challenge Chip stores no fixture and no scoreline — only `pointsAwarded`. The match is
 * rebuilt from each side's OWN regular fixture result for that gameweek. These tests pin the
 * rebuild rules, especially "both sides or nothing", which is what keeps a half-resolved
 * challenge off the screen.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  challengeOutcome,
  challengeOutcomeLabel,
  resolveChallengeMatches,
  resultKey,
  type ChallengeChipRow,
  type TeamGwResult,
} from "../../src/lib/formats/tvt/challenge-match";

const GW = "gw2";
const CHALLENGER = "t1";
const CHALLENGED = "t12";

const gwNumbers = new Map([[GW, 2]]);
const teamNames = new Map([
  [CHALLENGER, "Pakhala Army"],
  [CHALLENGED, "Cobham to Carrington"],
]);

function chip(over: Partial<ChallengeChipRow> = {}): ChallengeChipRow {
  return {
    id: "chip1",
    teamId: CHALLENGER,
    challengedTeamId: CHALLENGED,
    gameweekId: GW,
    pointsAwarded: 2,
    isProcessed: true,
    ...over,
  };
}

function results(entries: [string, TeamGwResult][]): Map<string, TeamGwResult> {
  return new Map(entries.map(([teamId, r]) => [resultKey(GW, teamId), r]));
}

const BOTH = results([
  [CHALLENGER, { score: 214, playerScores: '[{"name":"A","finalScore":214}]' }],
  [CHALLENGED, { score: 186, playerScores: '[{"name":"B","finalScore":186}]' }],
]);

/* ── happy path ─────────────────────────────────────────────────────────── */

test("rebuilds the challenge from both sides' own fixture results", () => {
  const out = resolveChallengeMatches([chip()], gwNumbers, teamNames, BOTH);
  const m = out.get("chip1");
  assert.ok(m);
  assert.equal(m.gameweek, 2);
  assert.equal(m.challengerTeamName, "Pakhala Army");
  assert.equal(m.challengedTeamName, "Cobham to Carrington");
  assert.equal(m.challengerScore, 214);
  assert.equal(m.challengedScore, 186);
  assert.equal(m.challengerPlayerScores, '[{"name":"A","finalScore":214}]');
  assert.equal(m.outcome, "won");
  assert.equal(m.pointsAwarded, 2);
});

test("the challenger keeps its side regardless of where each team sat in their own fixture", () => {
  // Both teams happen to have been the AWAY side of their own matches; the challenge is still
  // reported challenger-first.
  const out = resolveChallengeMatches([chip()], gwNumbers, teamNames, BOTH);
  const m = out.get("chip1")!;
  assert.equal(m.challengerScore, 214);
  assert.equal(m.challengedScore, 186);
});

/* ── both sides or nothing ──────────────────────────────────────────────── */

test("omits the chip when the challenged team has no result (bye or unscored)", () => {
  const only = results([[CHALLENGER, { score: 214, playerScores: null }]]);
  assert.equal(resolveChallengeMatches([chip()], gwNumbers, teamNames, only).size, 0);
});

test("omits the chip when the challenger has no result", () => {
  const only = results([[CHALLENGED, { score: 186, playerScores: null }]]);
  assert.equal(resolveChallengeMatches([chip()], gwNumbers, teamNames, only).size, 0);
});

test("omits a chip with no challenged team stored", () => {
  const out = resolveChallengeMatches([chip({ challengedTeamId: null })], gwNumbers, teamNames, BOTH);
  assert.equal(out.size, 0);
});

test("omits a chip whose gameweek or team cannot be named", () => {
  assert.equal(resolveChallengeMatches([chip()], new Map(), teamNames, BOTH).size, 0);
  assert.equal(resolveChallengeMatches([chip()], gwNumbers, new Map(), BOTH).size, 0);
});

/* ── outcome mapping ────────────────────────────────────────────────────── */

test("outcome maps 2/1/0 to won/drew/lost", () => {
  assert.equal(challengeOutcome(2, true), "won");
  assert.equal(challengeOutcome(1, true), "drew");
  assert.equal(challengeOutcome(0, true), "lost");
});

test("an unprocessed chip is pending and carries no points", () => {
  assert.equal(challengeOutcome(0, false), "pending");
  assert.equal(challengeOutcome(null, true), "pending");
  const out = resolveChallengeMatches([chip({ isProcessed: false, pointsAwarded: 0 })], gwNumbers, teamNames, BOTH);
  const m = out.get("chip1")!;
  assert.equal(m.outcome, "pending");
  assert.equal(m.pointsAwarded, null);
});

test("a drawn challenge reports +1, matching what the scorer actually awards", () => {
  // determineMatchResult gives 1 point each on a draw, so a drawn challenge is +1 — not the
  // 0 the written rules imply. Asserted so the discrepancy stays visible rather than drifting.
  const out = resolveChallengeMatches([chip({ pointsAwarded: 1 })], gwNumbers, teamNames, BOTH);
  assert.equal(out.get("chip1")!.outcome, "drew");
});

/* ── wording ────────────────────────────────────────────────────────────── */

test("labels talk in chip points, never in match results", () => {
  const base = resolveChallengeMatches([chip()], gwNumbers, teamNames, BOTH).get("chip1")!;
  assert.equal(challengeOutcomeLabel(base), "Won the challenge · +2 chip points");
  assert.equal(challengeOutcomeLabel({ ...base, outcome: "lost", pointsAwarded: 0 }), "Lost the challenge · no chip points");
  // Nothing may read as a league result — the challenge never counts as a match played.
  for (const o of ["won", "drew", "lost", "pending"] as const) {
    const label = challengeOutcomeLabel({ ...base, outcome: o, pointsAwarded: o === "drew" ? 1 : 2 });
    assert.ok(!/\bFinal\b|\bW\/L\b|league points/i.test(label), `label leaked fixture wording: ${label}`);
  }
});

test("resolves several chips in one pass", () => {
  const chips = [chip(), chip({ id: "chip2", teamId: CHALLENGED, challengedTeamId: CHALLENGER, pointsAwarded: 0 })];
  const out = resolveChallengeMatches(chips, gwNumbers, teamNames, BOTH);
  assert.equal(out.size, 2);
  assert.equal(out.get("chip2")!.challengerTeamName, "Cobham to Carrington");
  assert.equal(out.get("chip2")!.outcome, "lost");
});
