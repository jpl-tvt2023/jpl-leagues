import { db } from "@/lib/db";
import { gameweeks } from "@/lib/db/schema";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { getConcludedGwNumbers } from "@/lib/fpl/event-status";

/**
 * The "current" gameweek for a league: the lowest-numbered gameweek that has NOT
 * concluded per FPL. Returns null when the league has no gameweek rows at all.
 *
 * Why not "the highest gameweek whose deadline has passed" (the previous rule):
 * that made a gameweek current the moment its deadline passed and kept it current
 * for the whole following week. After GW1 finished on Sunday, the app still called
 * GW1 "current" until GW2's deadline the following Friday — nothing advanced on
 * conclusion. Deriving from FPL's own conclusion signal moves it the moment the
 * gameweek is actually over.
 *
 * Falls back to the deadline rule when FPL is unreachable, so an outage degrades to
 * the old behaviour rather than to null.
 *
 * Distinct from `getInFlightGameweekNumber` (in-flight.ts), which asks a different
 * question — "deadline passed but OUR results aren't written yet" — and drives live
 * scoring rather than display.
 */
export async function getCurrentGameweekNumber(leagueId: string): Promise<number | null> {
  const leagueGws = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId))
    .orderBy(asc(gameweeks.number));

  if (leagueGws.length === 0) return null;

  const concluded = await getConcludedGwNumbers();
  if (concluded) {
    const firstUnconcluded = leagueGws.find((g) => !concluded.has(g.number));
    // Every gameweek concluded — the season is over; the last one stays current.
    return firstUnconcluded?.number ?? leagueGws[leagueGws.length - 1].number;
  }

  // FPL unreachable — fall back to the deadline-based rule.
  return getCurrentGameweekNumberByDeadline(leagueId);
}

/**
 * The highest-numbered gameweek whose deadline has already passed, else the
 * lowest-numbered one. Exported for callers that specifically want the local,
 * FPL-independent answer, and used as the fallback above.
 */
export async function getCurrentGameweekNumberByDeadline(leagueId: string): Promise<number | null> {
  const now = new Date();

  const passedRows = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), lte(gameweeks.deadline, now)));

  if (passedRows.length > 0) {
    return passedRows.reduce((m, r) => (r.number > m ? r.number : m), passedRows[0].number);
  }

  const upcoming = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId))
    .orderBy(asc(gameweeks.number))
    .limit(1);

  return upcoming[0]?.number ?? null;
}

/**
 * The highest-numbered gameweek whose deadline has passed, or 0 before any has — the gameweek an
 * auction ownership change happens "in". A player released now keeps scoring for his old team up
 * to and including it (`releasedGw`), and one bought now scores for his new team from the next one
 * (`acquiredGw`), so the two sides of a change can never both score the same gameweek.
 *
 * Unlike getCurrentGameweekNumberByDeadline this never falls back to the first gameweek: before
 * GW1's deadline the answer must be 0, or a pre-season buy would miss GW1.
 */
export async function getStartedGameweekNumber(leagueId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), lte(gameweeks.deadline, now)))
    .orderBy(desc(gameweeks.number))
    .limit(1);
  return row?.number ?? 0;
}
