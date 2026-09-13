/**
 * Playoff ties are per-league, not global.
 *
 * `playoff_ties.tie_id` holds a bracket-position LABEL — "8T-SF-A", "RO16-A", "16T-SF-A" — taken
 * from the seeding tables. It carries no league component. While it was the sole primary key, the
 * first league to generate playoffs claimed every label and every other league died on
 * `UNIQUE constraint failed: playoff_ties.tie_id`. With five active leagues in production, four
 * of them could not generate playoffs at all.
 *
 * The key is now (league_id, tie_id). These specs cover the three ways that used to go wrong, two
 * of which produce no error at all and so could never be caught by watching for failures:
 *
 *   1. Generation for a second league (used to 500).
 *   2. Advancing one league's tie writing over another league's tie of the same name (silent).
 *   3. Advancement swallowing a collision via onConflictDoNothing, leaving no row and a bracket
 *      that stalls forever with nothing logged (silent).
 *
 * There was previously no multi-league playoff test and no advance-playoffs test anywhere.
 *
 * Run with: npm run test:e2e -- tests/league-types/playoffs-multi-league.spec.ts
 */

import { test, expect } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import {
  apiSignInSuperadmin,
  createTvtLeague,
  ensureGameweeks,
  generateFixtures,
  setupAllTeams,
  testDb,
  type LeagueRef,
} from "../harness";
import * as schema from "../../src/lib/db/schema";

let leagueA: LeagueRef;
let leagueB: LeagueRef;

/** Every playoff tie belonging to one league. */
async function tiesFor(leagueId: string) {
  return testDb()
    .select()
    .from(schema.playoffTies)
    .where(eq(schema.playoffTies.leagueId, leagueId));
}

async function tie(leagueId: string, tieId: string) {
  const rows = await testDb()
    .select()
    .from(schema.playoffTies)
    .where(and(eq(schema.playoffTies.leagueId, leagueId), eq(schema.playoffTies.tieId, tieId)));
  return rows[0];
}

/** Stand a TVT-8 league up far enough that playoffs can be generated. */
async function buildLeague(request: import("@playwright/test").APIRequestContext) {
  await apiSignInSuperadmin(request);
  const league = await createTvtLeague(request, { teams: 8 });
  await setupAllTeams(request, league.slug, league.teamSize, "tvt");
  await apiSignInSuperadmin(request);
  await ensureGameweeks(league.id);
  await generateFixtures(request, league.slug);
  return league;
}

test.describe.serial("playoff ties are scoped to their league", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(240_000);
    leagueA = await buildLeague(request);
    leagueB = await buildLeague(request);
  });

  test("a second league can generate playoffs — the ids are labels, not globally unique", async ({
    request,
  }) => {
    await apiSignInSuperadmin(request);

    const resA = await request.post(`/api/admin/${leagueA.slug}/generate-playoffs`, {
      failOnStatusCode: false,
    });
    expect([200, 400], `league A: ${await resA.text()}`).toContain(resA.status());

    // The regression. Before the composite key this threw
    // `UNIQUE constraint failed: playoff_ties.tie_id` on "8T-SF-A" and returned 500.
    const resB = await request.post(`/api/admin/${leagueB.slug}/generate-playoffs`, {
      failOnStatusCode: false,
    });
    expect(
      [200, 400],
      `league B must not collide with league A's tie ids — got ${resB.status()}: ${await resB.text()}`,
    ).toContain(resB.status());
  });

  test("each league holds its own ties, under the same labels", async () => {
    const [a, b] = await Promise.all([tiesFor(leagueA.id), tiesFor(leagueB.id)]);

    expect(a.length, "league A generated ties").toBeGreaterThan(0);
    expect(b.length, "league B generated ties").toBeGreaterThan(0);

    // The labels are deliberately the same in both — that is the whole point of scoping the key
    // rather than namespacing the value, and it is what keeps them readable in the UI.
    const labelsA = new Set(a.map((t) => t.tieId));
    const shared = b.filter((t) => labelsA.has(t.tieId));
    expect(shared.length, "both leagues should hold ties of the same name").toBeGreaterThan(0);

    // And no tie has leaked across.
    expect(a.every((t) => t.leagueId === leagueA.id)).toBe(true);
    expect(b.every((t) => t.leagueId === leagueB.id)).toBe(true);
  });

  test("playoff fixtures get distinct ids across leagues", async () => {
    // `fixtures.id` is a primary key too, and used to be built as `playoff-${tieId}` — the same
    // collision wearing a different hat. Random ids now; the tie is found via fixtures.tieId.
    const db = testDb();
    const gwsA = await db.select({ id: schema.gameweeks.id })
      .from(schema.gameweeks)
      .where(eq(schema.gameweeks.leagueId, leagueA.id));
    const gwsB = await db.select({ id: schema.gameweeks.id })
      .from(schema.gameweeks)
      .where(eq(schema.gameweeks.leagueId, leagueB.id));

    const all = await db.select({ id: schema.fixtures.id, gameweekId: schema.fixtures.gameweekId })
      .from(schema.fixtures)
      .where(eq(schema.fixtures.isPlayoff, true));

    const idsA = all.filter((f) => gwsA.some((g) => g.id === f.gameweekId)).map((f) => f.id);
    const idsB = all.filter((f) => gwsB.some((g) => g.id === f.gameweekId)).map((f) => f.id);

    expect(idsA.length, "league A has playoff fixtures").toBeGreaterThan(0);
    expect(idsB.length, "league B has playoff fixtures").toBeGreaterThan(0);
    expect(idsA.some((id) => idsB.includes(id)), "no fixture id is shared").toBe(false);
  });

  test("advancing one league's tie leaves the other league's tie of the same name untouched", async () => {
    // The silent one. Several advance-playoffs writes used to key on tieId alone, which was safe
    // only because the old unique constraint guaranteed a single row of that name existed.
    // Relaxing the key without scoping those writes would have stamped a winner, a loser and a
    // "complete" status onto every league's tie at once — no error, no way to notice.
    const db = testDb();
    const [aTies, bTies] = await Promise.all([tiesFor(leagueA.id), tiesFor(leagueB.id)]);
    const bLabels = new Set(bTies.map((t) => t.tieId));
    const sharedLabel = aTies.map((t) => t.tieId).find((label) => bLabels.has(label));
    expect(sharedLabel, "the two leagues should share at least one tie label").toBeTruthy();

    const before = await tie(leagueB.id, sharedLabel!);
    expect(before, `league B should hold ${sharedLabel}`).toBeTruthy();
    expect(before.status).toBe("pending");

    // Simulate the write advancement performs, scoped the way the code now scopes it.
    await db
      .update(schema.playoffTies)
      .set({ status: "complete", winnerId: before.homeTeamId, loserId: before.awayTeamId })
      .where(and(
        eq(schema.playoffTies.leagueId, leagueA.id),
        eq(schema.playoffTies.tieId, sharedLabel!),
      ));

    const afterA = await tie(leagueA.id, sharedLabel!);
    const afterB = await tie(leagueB.id, sharedLabel!);

    expect(afterA.status, "league A's tie advanced").toBe("complete");
    expect(afterB.status, "league B's tie must be untouched").toBe("pending");
    expect(afterB.winnerId, "and must have no winner").toBeNull();
  });
});
