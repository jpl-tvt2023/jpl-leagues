/**
 * Auction start gameweek + configurable release-cycle gameweeks.
 *
 * Covers the write paths added alongside those two league columns:
 *   - creating a league that begins scoring mid-season
 *   - create-gameweeks seeding only from the start GW
 *   - PATCH /api/admin/[leagueId]/auction-config (validation + the scored-GW lock)
 *
 * Run with: npm run test:e2e -- tests/league-types/auction-start-gw.spec.ts
 */

import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { apiSignInSuperadmin, testDb, schema } from "../harness";
import { randomUUID } from "crypto";

const START_GW = 15;
const CYCLES = "18, 28";

let leagueId: string;
let leagueSlug: string;
let tvtLeagueId: string;
let tvtSlug: string;

async function leagueRow(id: string) {
  const db = testDb();
  const rows = await db.select().from(schema.leagues).where(eq(schema.leagues.id, id)).limit(1);
  return rows[0];
}

async function gwNumbers(id: string): Promise<number[]> {
  const db = testDb();
  const rows = await db
    .select({ number: schema.gameweeks.number })
    .from(schema.gameweeks)
    .where(eq(schema.gameweeks.leagueId, id));
  return rows.map((r) => r.number).sort((a, b) => a - b);
}

test.describe.serial("Auction start gameweek + release cycles", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);

    leagueSlug = `asg-${Date.now().toString(36)}`;
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug: leagueSlug, name: "Auction Start GW", sport: "fpl", format: "auction",
        season: "2025-26", teamSize: 4, auctionTier: "primary", isSimulated: true,
        startGameweek: START_GW, releaseCycleGws: CYCLES,
      },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    leagueId = (await res.json()).id;

    tvtSlug = `asg-tvt-${Date.now().toString(36)}`;
    const tvt = await request.post("/api/superadmin/leagues", {
      data: {
        slug: tvtSlug, name: "Start GW TVT guard", sport: "fpl", format: "tvt",
        season: "2025-26", teamSize: 8,
      },
      failOnStatusCode: false,
    });
    expect(tvt.status(), await tvt.text()).toBe(200);
    tvtLeagueId = (await tvt.json()).id;
  });

  // Playwright hands each test its own request context, so the beforeAll session
  // does not carry over — the sibling auction specs re-sign-in per test too.
  test.beforeEach(async ({ request }) => {
    await apiSignInSuperadmin(request);
  });

  test("creation stores the start gameweek and normalises the cycle list", async () => {
    const row = await leagueRow(leagueId);
    expect(row.startGameweek).toBe(START_GW);
    expect(row.releaseCycleGws).toBe("[18,28]");
  });

  test("non-auction formats are pinned to GW1 and the legacy cadence", async () => {
    const row = await leagueRow(tvtLeagueId);
    expect(row.startGameweek).toBe(1);
    expect(row.releaseCycleGws).toBe("[10,20,30]");
  });

  test("creation rejects a cycle gameweek before the start gameweek", async ({ request }) => {
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug: `asg-bad-${Date.now().toString(36)}`, name: "bad", sport: "fpl", format: "auction",
        season: "2025-26", teamSize: 4, startGameweek: 20, releaseCycleGws: "10, 20",
      },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("between 20 and 38");
  });

  test("create-gameweeks seeds only from the start gameweek", async ({ request }) => {
    const res = await request.post(`/api/admin/${leagueSlug}/create-gameweeks`, { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.startGameweek).toBe(START_GW);

    const numbers = await gwNumbers(leagueId);
    expect(numbers.length).toBe(38 - START_GW + 1);
    expect(Math.min(...numbers)).toBe(START_GW);
    expect(Math.max(...numbers)).toBe(38);
    expect(numbers.some((n) => n < START_GW)).toBe(false);
  });

  test("auction-config moves the start gameweek and drops out-of-range gameweeks", async ({ request }) => {
    const res = await request.patch(`/api/admin/${leagueSlug}/auction-config`, {
      data: { startGameweek: 20, releaseCycleGws: "25, 32" },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.startGameweek).toBe(20);
    expect(body.releaseCycleGws).toEqual([25, 32]);

    const numbers = await gwNumbers(leagueId);
    expect(Math.min(...numbers)).toBe(20);
    expect(numbers.some((n) => n < 20)).toBe(false);
  });

  test("auction-config rejects invalid cycle lists", async ({ request }) => {
    for (const bad of ["25, 25", "", "40", "5"]) {
      const res = await request.patch(`/api/admin/${leagueSlug}/auction-config`, {
        data: { releaseCycleGws: bad },
        failOnStatusCode: false,
      });
      expect(res.status(), `expected 400 for ${JSON.stringify(bad)}`).toBe(400);
    }
    // Rejected input must not have disturbed the stored value.
    expect((await leagueRow(leagueId)).releaseCycleGws).toBe("[25,32]");
  });

  test("auction-config refuses non-auction leagues", async ({ request }) => {
    const res = await request.patch(`/api/admin/${tvtSlug}/auction-config`, {
      data: { startGameweek: 5 },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("auction leagues");
  });

  test("start gameweek locks once a gameweek has been scored", async ({ request }) => {
    const db = testDb();
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, leagueId)).limit(1);
    const [gw] = await db.select().from(schema.gameweeks).where(eq(schema.gameweeks.leagueId, leagueId)).limit(1);

    await db.insert(schema.auctionScores).values({
      id: randomUUID(), leagueId, teamId: team.id, gameweekId: gw.id,
      totalPoints: 42, rawPoints: 42, playerBreakdown: "[]",
    });

    const res = await request.patch(`/api/admin/${leagueSlug}/auction-config`, {
      data: { startGameweek: 25, releaseCycleGws: "30" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toContain("after a gameweek has been scored");
    expect((await leagueRow(leagueId)).startGameweek).toBe(20);

    // Release gameweeks stay editable after scoring has begun.
    const ok = await request.patch(`/api/admin/${leagueSlug}/auction-config`, {
      data: { releaseCycleGws: "26, 33" },
      failOnStatusCode: false,
    });
    expect(ok.status(), await ok.text()).toBe(200);
    expect((await leagueRow(leagueId)).releaseCycleGws).toBe("[26,33]");
  });
});
