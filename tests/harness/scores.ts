/**
 * Direct DB writes for results — bypasses the production scoring pipeline
 * (which fetches live FPL data and processes captain/chip math). For test
 * purposes we want deterministic scores so we can assert standings exactly.
 *
 * For richer scenarios (chip math, captain doubling, synergy bonuses) drive
 * the real /api/gameweeks/[gw] processor instead — see gameweek.ts.
 */

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testDb, schema } from "./db";

interface ScoreInput {
  fixtureId: string;
  homeScore: number;
  awayScore: number;
  /** Provide the home team id so we can write the team-attribution row correctly. */
  homeTeamId: string;
}

/**
 * Insert (or replace) a results row for a fixture. Match points are derived
 * from home/away score using the standard W=2 / D=1 / L=0 mapping.
 */
export async function setFixtureResult(input: ScoreInput): Promise<void> {
  const db = testDb();
  const { fixtureId, homeScore, awayScore, homeTeamId } = input;
  const homePts = homeScore > awayScore ? 2 : homeScore === awayScore ? 1 : 0;
  const awayPts = awayScore > homeScore ? 2 : awayScore === homeScore ? 1 : 0;

  // Wipe any existing row (results.fixtureId is unique).
  await db.delete(schema.results).where(eq(schema.results.fixtureId, fixtureId));

  await db.insert(schema.results).values({
    id: randomUUID(),
    fixtureId,
    teamId: homeTeamId,
    homeScore,
    awayScore,
    homeMatchPoints: homePts,
    awayMatchPoints: awayPts,
    homeGotBonus: false,
    awayGotBonus: false,
    homeUsedDoublePointer: false,
    awayUsedDoublePointer: false,
  });
}

/**
 * Apply a deterministic score map to every fixture in a gameweek.
 * `scorer` returns the home/away scores for a fixture index (0-based).
 */
export async function scoreGameweek(
  leagueId: string,
  gwNumber: number,
  scorer: (fixtureIndex: number) => { home: number; away: number },
): Promise<number> {
  const db = testDb();
  const gws = await db
    .select({ id: schema.gameweeks.id })
    .from(schema.gameweeks)
    .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, gwNumber)))
    .limit(1);
  if (!gws[0]) throw new Error(`scoreGameweek: GW${gwNumber} not found for league ${leagueId}`);

  const fxs = await db
    .select({ id: schema.fixtures.id, homeTeamId: schema.fixtures.homeTeamId })
    .from(schema.fixtures)
    .where(eq(schema.fixtures.gameweekId, gws[0].id));

  for (let i = 0; i < fxs.length; i++) {
    const { home, away } = scorer(i);
    await setFixtureResult({
      fixtureId: fxs[i].id,
      homeScore: home,
      awayScore: away,
      homeTeamId: fxs[i].homeTeamId,
    });
  }
  return fxs.length;
}

/**
 * Write a per-team auction score row for a gameweek. Used by auction-format
 * specs to assert standings + payouts without running the real scoring job.
 */
export async function setAuctionScore(input: {
  leagueId: string;
  teamId: string;
  gwNumber: number;
  totalPoints: number;
  rawPoints?: number;
  synergyBonus?: number;
  clubResultBonus?: number;
  rank?: number;
  payout?: number;
}): Promise<void> {
  const db = testDb();
  const gws = await db
    .select({ id: schema.gameweeks.id })
    .from(schema.gameweeks)
    .where(
      and(eq(schema.gameweeks.leagueId, input.leagueId), eq(schema.gameweeks.number, input.gwNumber)),
    )
    .limit(1);
  if (!gws[0]) throw new Error(`setAuctionScore: GW${input.gwNumber} not found for league ${input.leagueId}`);

  await db
    .insert(schema.auctionScores)
    .values({
      id: randomUUID(),
      leagueId: input.leagueId,
      teamId: input.teamId,
      gameweekId: gws[0].id,
      totalPoints: input.totalPoints,
      rawPoints: input.rawPoints ?? input.totalPoints,
      synergyBonus: input.synergyBonus ?? 0,
      clubResultBonus: input.clubResultBonus ?? 0,
      playerBreakdown: "[]",
      rank: input.rank,
      payout: input.payout ?? 0,
    })
    .onConflictDoUpdate({
      target: [
        schema.auctionScores.leagueId,
        schema.auctionScores.teamId,
        schema.auctionScores.gameweekId,
      ],
      set: {
        totalPoints: input.totalPoints,
        rawPoints: input.rawPoints ?? input.totalPoints,
        synergyBonus: input.synergyBonus ?? 0,
        clubResultBonus: input.clubResultBonus ?? 0,
        rank: input.rank,
        payout: input.payout ?? 0,
      },
    });
}
