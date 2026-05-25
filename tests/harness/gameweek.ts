/**
 * Gameweek helpers.
 *
 * The production /api/admin/[leagueId]/create-gameweeks route fetches deadlines
 * from fantasy.premierleague.com — we cannot hit that from tests. Instead we
 * insert GW rows directly via Drizzle with deterministic future deadlines so
 * captain/chip submission and deadline-sensitive flows behave correctly.
 *
 * Generate-fixtures already creates league-stage gameweeks for TVT and Triple
 * Crown formats, so this helper is primarily for auction leagues and for
 * specs that want a known future deadline.
 */

import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { testDb, schema } from "./db";

/**
 * Ensure GW 1..38 exist for the league. Every deadline is set to +30 days
 * from now so deadline checks never trip during a test run. Idempotent —
 * existing rows are left untouched.
 */
export async function ensureGameweeks(leagueId: string, count = 38): Promise<void> {
  const db = testDb();
  const existing = await db
    .select({ number: schema.gameweeks.number })
    .from(schema.gameweeks)
    .where(eq(schema.gameweeks.leagueId, leagueId));
  const have = new Set(existing.map((r) => r.number));

  const base = Date.now() + 30 * 24 * 3600 * 1000;
  for (let n = 1; n <= count; n++) {
    if (have.has(n)) continue;
    await db.insert(schema.gameweeks).values({
      id: randomUUID(),
      number: n,
      leagueId,
      deadline: new Date(base + n * 60_000),
      isPlayoffs: n >= 31, // matches production heuristic
    });
  }
}

/**
 * Force a single gameweek's deadline into the past so a spec can assert
 * late-announcement behavior (penalty audit log, isValid=false, etc.).
 */
export async function expireGameweek(leagueId: string, gwNumber: number): Promise<void> {
  const db = testDb();
  await db
    .update(schema.gameweeks)
    .set({ deadline: new Date(Date.now() - 60_000) })
    .where(
      and(
        eq(schema.gameweeks.leagueId, leagueId),
        eq(schema.gameweeks.number, gwNumber),
      ),
    );
}
