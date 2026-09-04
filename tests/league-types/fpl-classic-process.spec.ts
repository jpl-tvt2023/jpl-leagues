/**
 * FPL Classic — the settle sweep and award freezing.
 *
 * This is the highest-risk logic in the whole format. Two invariants this file exists to pin:
 *
 *  1. The settled cursor only ever advances to a gameweek every active entrant has a row for —
 *     re-running Process must be a true no-op once caught up (zero new rows, zero new FPL calls).
 *  2. A FROZEN award never changes on its own, even if the underlying settled data is edited
 *     afterward — only an explicit superadmin force-recompute can move it, and that recompute
 *     writes the old winner to the audit log first.
 *
 * Run with: npm run test:e2e -- tests/league-types/fpl-classic-process.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { eq, and } from "drizzle-orm";
import {
  apiSignInSuperadmin, apiSignOut, createFplClassicLeague, testDb, schema, uniqueSlug,
} from "../harness";

const STUB_ENTRANT_COUNT = 120;

/**
 * A classic league of this file's own, MERGED into the stub's existing set rather than replacing
 * it. /control does outright replacement, so posting just this league would delete the stub's
 * default 900001 league that the other fpl-classic specs depend on — and stub state is global
 * across spec files for the whole run.
 */
async function seedClassicLeague(request: APIRequestContext, fplLeagueId: number, entryCount: number) {
  await apiSignInSuperadmin(request);
  const entryIds = Array.from({ length: entryCount }, (_, i) => 800_001 + i);
  const current = await request.get("/api/test-fpl-stub/control").then((r) => r.json());
  await request.post("/api/test-fpl-stub/control", {
    data: {
      classicLeagues: {
        ...(current.classicLeagues ?? {}),
        [String(fplLeagueId)]: { name: "Process Test League", startEvent: 1, entryIds },
      },
    },
  });
  const league = await createFplClassicLeague(request, { fplLeagueId, season: uniqueSlug("s") });
  return league;
}

async function process(request: APIRequestContext, leagueId: string, body: Record<string, unknown> = {}) {
  const res = await request.post(`/api/superadmin/fpl-classic/${leagueId}/process`, { data: body });
  expect(res.ok(), await res.text()).toBe(true);
  return res.json();
}

async function processUntilDone(request: APIRequestContext, leagueId: string, maxCalls = 5) {
  let last;
  for (let i = 0; i < maxCalls; i++) {
    last = await process(request, leagueId);
    if (last.done) return last;
  }
  throw new Error(`process did not reach done within ${maxCalls} calls: ${JSON.stringify(last)}`);
}

test.describe.serial("FPL Classic — settle sweep and award freezing", () => {
  const FPL_LEAGUE_ID = 910_001;
  let leagueId: string;
  let slug: string;

  test.beforeAll(async ({ request }) => {
    const league = await seedClassicLeague(request, FPL_LEAGUE_ID, STUB_ENTRANT_COUNT);
    leagueId = league.id;
    slug = league.slug;
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 3, liveGw: null } });
  });

  test.afterAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: null } });
  });

  test("an unauthenticated process call is rejected", async ({ request }) => {
    await apiSignOut(request);
    const res = await request.post(`/api/superadmin/fpl-classic/${leagueId}/process`, { data: {}, failOnStatusCode: false });
    expect([401, 403]).toContain(res.status());
  });

  test("processing settles every concluded gameweek and freezes what's ready", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const result = await processUntilDone(request, leagueId);
    expect(result.settledThroughGw).toBe(3);
    expect(result.remainingEntrants).toBe(0);

    const db = testDb();
    const rows = await db.select().from(schema.fplClassicEntryGws).where(eq(schema.fplClassicEntryGws.leagueId, leagueId));
    expect(rows.length).toBe(STUB_ENTRANT_COUNT * 3);

    const [config] = await db.select().from(schema.fplClassicConfig).where(eq(schema.fplClassicConfig.leagueId, leagueId)).limit(1);
    expect(config.settledThroughGw).toBe(3);
    expect(config.lastSyncError).toBeNull();
  });

  test("gw:1, gw:2, gw:3 are frozen; season is not (GW38 not reached)", async ({ request }) => {
    const db = testDb();
    const awards = await db.select().from(schema.fplClassicAwards).where(eq(schema.fplClassicAwards.leagueId, leagueId));
    const scopeKeys = new Set(awards.map((a) => a.scopeKey));
    expect(scopeKeys.has("gw:1")).toBe(true);
    expect(scopeKeys.has("gw:2")).toBe(true);
    expect(scopeKeys.has("gw:3")).toBe(true);
    expect(scopeKeys.has("season")).toBe(false);
    expect(scopeKeys.has("gw:4")).toBe(false); // GW4 not settled

    // Reachable through the public API too, and marked final.
    const body = await request.get(`/api/fpl-classic/standings?leagueSlug=${slug}`).then((r) => r.json());
    const gw1Award = body.awards.find((a: { scopeKey: string }) => a.scopeKey === "gw:1");
    expect(gw1Award).toBeTruthy();
    expect(gw1Award.status).toBe("final");
    expect(gw1Award.winners.length).toBeGreaterThan(0);
  });

  test("re-processing after catching up is a true no-op: zero new rows, zero new FPL calls", async ({ request }) => {
    await apiSignInSuperadmin(request);
    await request.post("/api/test-fpl-stub/control", { data: { resetCounts: true } });
    const db = testDb();
    const before = await db.select().from(schema.fplClassicEntryGws).where(eq(schema.fplClassicEntryGws.leagueId, leagueId));

    const result = await process(request, leagueId, { step: "settle" });
    expect(result.done).toBe(true);
    expect(result.remainingEntrants).toBe(0);

    const after = await db.select().from(schema.fplClassicEntryGws).where(eq(schema.fplClassicEntryGws.leagueId, leagueId));
    expect(after.length).toBe(before.length);

    const counts = await request.get("/api/test-fpl-stub/control").then((r) => r.json());
    expect(counts.counts["entry/history"] ?? 0).toBe(0);
  });

  test("a frozen award never changes on its own, even if the underlying row is edited", async ({ request }) => {
    const db = testDb();
    // ALL frozen rows for this scope, not just one: the stub's scores genuinely produce ties, so
    // a gameweek winner can legitimately be several entrants sharing rank 1.
    const frozenBefore = await db
      .select()
      .from(schema.fplClassicAwards)
      .where(and(eq(schema.fplClassicAwards.leagueId, leagueId), eq(schema.fplClassicAwards.scopeKey, "gw:1"), eq(schema.fplClassicAwards.awardType, "gw-winner")));
    expect(frozenBefore.length, "GW1 winner(s) should already be frozen").toBeGreaterThan(0);

    // Simulate FPL correcting scores after the fact: flatten EVERY GW1 row to the same value.
    // A live recompute over this data would report all 120 entrants tied for first; a frozen
    // award reports exactly the one winner that was persisted. That difference is the assertion.
    await db.update(schema.fplClassicEntryGws)
      .set({ netPoints: 99999, points: 99999 })
      .where(and(eq(schema.fplClassicEntryGws.leagueId, leagueId), eq(schema.fplClassicEntryGws.gw, 1)));

    const body = await request.get(`/api/fpl-classic/standings?leagueSlug=${slug}`).then((r) => r.json());
    const gw1Award = body.awards.find((a: { scopeKey: string }) => a.scopeKey === "gw:1");
    expect(gw1Award.status).toBe("final");
    // Exactly the entrants frozen before the edit — read verbatim, never re-derived.
    expect(gw1Award.winners.map((w: { entrantId: string }) => w.entrantId).sort()).toEqual(
      frozenBefore.map((r) => r.entrantId).sort(),
    );
    // And decisively NOT a live recompute: the flattened data above would tie all 120 entrants.
    expect(gw1Award.winners.length).toBeLessThan(STUB_ENTRANT_COUNT);
  });

  test("force-recompute overwrites the frozen award and logs the previous winner", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const db = testDb();
    const [beforeAward] = await db
      .select()
      .from(schema.fplClassicAwards)
      .where(and(eq(schema.fplClassicAwards.leagueId, leagueId), eq(schema.fplClassicAwards.scopeKey, "gw:1"), eq(schema.fplClassicAwards.awardType, "gw-winner")))
      .limit(1);

    const result = await process(request, leagueId, { step: "freeze", force: true });
    expect(result.frozen).toContain("gw:1");

    const [afterAward] = await db
      .select()
      .from(schema.fplClassicAwards)
      .where(and(eq(schema.fplClassicAwards.leagueId, leagueId), eq(schema.fplClassicAwards.scopeKey, "gw:1"), eq(schema.fplClassicAwards.awardType, "gw-winner")))
      .limit(1);
    // Recomputed from the now-99999-everywhere rows: the winner changed and recomputeCount advanced.
    expect(afterAward.recomputeCount).toBeGreaterThan(beforeAward.recomputeCount);

    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.type, "FPL_CLASSIC_AWARD_RECOMPUTE"));
    const relevant = logs.find((l) => l.description.includes(leagueId) && l.description.includes("gw:1"));
    expect(relevant, "the previous winner should be logged before being overwritten").toBeTruthy();
    expect(relevant!.description).toContain(beforeAward.entrantId);
  });

  test("the Operations tab listing reports this league's settle progress", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const res = await request.get("/api/superadmin/fpl-classic/leagues");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const row = body.leagues.find((l: { id: string }) => l.id === leagueId);
    expect(row).toBeTruthy();
    expect(row.entrantCount).toBe(STUB_ENTRANT_COUNT);
    expect(row.settledThroughGw).toBe(3);
    expect(row.frozenScopeCount).toBeGreaterThanOrEqual(3); // at least gw:1, gw:2, gw:3
  });
});
