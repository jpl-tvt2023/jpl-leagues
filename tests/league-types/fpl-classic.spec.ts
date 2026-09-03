/**
 * FPL Classic — a public, read-only league built from nothing but an FPL classic league id.
 *
 * The regression that matters most in this whole format: creation must NOT create any `teams`
 * rows. Every other format's superadmin creation route auto-creates `teamSize` login accounts;
 * this format achieves "none of that" by forcing `teamSize: 0` so that loop runs zero times —
 * this spec is what proves that actually holds.
 *
 * Run with: npm run test:e2e -- tests/league-types/fpl-classic.spec.ts
 */

import { test, expect } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import {
  apiSignInSuperadmin,
  createFplClassicLeague,
  createTvtLeague,
  deleteLeague,
  testDb,
  schema,
} from "../harness";

// Seeded by the FPL stub's default classicLeagues state — 120 entrants, so 50/page pagination
// is genuinely exercised (3 pages).
const STUB_LEAGUE_ID = 900001;
const STUB_ENTRANT_COUNT = 120;

// Each test signs in for itself — Playwright's `request` fixture inside beforeAll is a
// different APIRequestContext from the one each test() receives, so a session established in
// beforeAll does not carry over (the same reason tvt-32.spec.ts re-signs-in inside every test
// that needs one, rather than relying on its own beforeAll's sign-in).
test.describe.serial("FPL Classic league creation", () => {
  // Unlike the sibling specs, this one asserts the EXACT derived slug ("league-900001", no season
  // suffix), which only holds when that slug is free. test.db persists across local runs, so
  // without this the second run gets the -<season> fallback and the third 409s. Clearing first
  // also recovers the spec from a previous crashed run.
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    const db = testDb();
    const stale = await db
      .select({ id: schema.leagues.id })
      .from(schema.leagues)
      // Exact slugs only. A `like("league-900001%")` would also match the uniquely-seasoned
      // leagues the sibling fpl-classic specs create against this same stub league id.
      .where(inArray(schema.leagues.slug, [`league-${STUB_LEAGUE_ID}`, `league-${STUB_LEAGUE_ID}-2026-27`]));
    for (const row of stale) await deleteLeague(request, row.id);
  });

  test("creating with only a league id returns the FPL name, entrant count, and a derived slug", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const league = await createFplClassicLeague(request, { fplLeagueId: STUB_LEAGUE_ID });

    expect(league.format).toBe("fpl-classic");
    expect(league.slug).toBe(`league-${STUB_LEAGUE_ID}`);
    expect(league.name).toBe("Stub Classic"); // the stub's default league name
    expect(league.fplLeagueId).toBe(STUB_LEAGUE_ID);
    expect(league.entrantCount).toBe(STUB_ENTRANT_COUNT);
    expect(league.truncated).toBe(false);
  });

  test("no team login accounts exist for this league — the regression that matters most", async () => {
    const db = testDb();
    const [league] = await db.select().from(schema.leagues).where(eq(schema.leagues.slug, `league-${STUB_LEAGUE_ID}`)).limit(1);
    expect(league, "league should exist from the previous test").toBeTruthy();

    const teamRows = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, league!.id));
    expect(teamRows.length).toBe(0);
  });

  test("every entrant from the paginated FPL roster was persisted", async () => {
    const db = testDb();
    const [league] = await db.select().from(schema.leagues).where(eq(schema.leagues.slug, `league-${STUB_LEAGUE_ID}`)).limit(1);
    const entrants = await db
      .select()
      .from(schema.fplClassicEntrants)
      .where(eq(schema.fplClassicEntrants.leagueId, league!.id));

    expect(entrants.length).toBe(STUB_ENTRANT_COUNT);
    // Pagination worked if ids from every page landed — page 1 starts at 700001, page 3 (the
    // last, partial page for 120 entrants at 50/page) reaches up to 700120.
    const fplIds = entrants.map((e) => e.fplEntryId).sort((a, b) => a - b);
    expect(fplIds[0]).toBe(700_001);
    expect(fplIds[fplIds.length - 1]).toBe(700_120);

    // Every entrant is a founding member as of league creation.
    expect(entrants.every((e) => e.firstSeenGw === 1)).toBe(true);
    expect(entrants.every((e) => e.isActive)).toBe(true);
  });

  test("the config row carries the league's own settings, unpersisted extras defaulted", async () => {
    const db = testDb();
    const [league] = await db.select().from(schema.leagues).where(eq(schema.leagues.slug, `league-${STUB_LEAGUE_ID}`)).limit(1);
    const [config] = await db.select().from(schema.fplClassicConfig).where(eq(schema.fplClassicConfig.leagueId, league!.id)).limit(1);

    expect(config).toBeTruthy();
    expect(config!.fplLeagueId).toBe(STUB_LEAGUE_ID);
    expect(config!.fplLeagueName).toBe("Stub Classic");
    expect(config!.scoringMetric).toBe("net"); // default
    expect(config!.winnerCutPercent).toBe(30); // default
    expect(config!.settledThroughGw).toBe(0);
    expect(config!.startGameweek).toBe(1);
  });

  test("an unknown FPL league id is rejected, and creates no league row", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const db = testDb();
    const before = await db.select({ id: schema.leagues.id }).from(schema.leagues);

    const res = await request.post("/api/superadmin/leagues", {
      data: { sport: "fpl", format: "fpl-classic", season: "2025-26", fplLeagueId: 999_999 },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("999999");

    const after = await db.select({ id: schema.leagues.id }).from(schema.leagues);
    expect(after.length).toBe(before.length);
  });

  test("a non-integer fplLeagueId is rejected before any FPL call", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const res = await request.post("/api/superadmin/leagues", {
      data: { sport: "fpl", format: "fpl-classic", season: "2025-26", fplLeagueId: "not-a-number" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });

  test("a second season of the SAME FPL league gets a distinct, season-suffixed slug", async ({ request }) => {
    // The FPL league id recurs; the same slug would otherwise collide with the league created
    // in the first test in this file.
    await apiSignInSuperadmin(request);
    const league = await createFplClassicLeague(request, {
      fplLeagueId: STUB_LEAGUE_ID,
      season: "2026-27",
    });
    expect(league.slug).not.toBe(`league-${STUB_LEAGUE_ID}`);
    expect(league.slug).toContain(`league-${STUB_LEAGUE_ID}`);
    expect(league.slug).toContain("2026-27".toLowerCase());
  });

  test("startGameweek, scoringMetric, and winnerCutPercent are honoured and validated", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const league = await createFplClassicLeague(request, {
      fplLeagueId: STUB_LEAGUE_ID,
      season: "2027-28",
      startGameweek: 5,
      scoringMetric: "gross",
      winnerCutPercent: 20,
    });

    const db = testDb();
    const [config] = await db.select().from(schema.fplClassicConfig).where(eq(schema.fplClassicConfig.leagueId, league.id)).limit(1);
    expect(config!.startGameweek).toBe(5);
    expect(config!.scoringMetric).toBe("gross");
    expect(config!.winnerCutPercent).toBe(20);
    // Entrants created at league creation are founding members of GW5, not GW1 — the league did
    // not exist before then.
    const entrants = await db
      .select()
      .from(schema.fplClassicEntrants)
      .where(eq(schema.fplClassicEntrants.leagueId, league.id));
    expect(entrants.every((e) => e.firstSeenGw === 5)).toBe(true);

    const badRes = await request.post("/api/superadmin/leagues", {
      data: { sport: "fpl", format: "fpl-classic", season: "2028-29", fplLeagueId: STUB_LEAGUE_ID, winnerCutPercent: 150 },
      failOnStatusCode: false,
    });
    expect(badRes.status()).toBe(400);
  });

  test("zero-impact regression: a TVT league created alongside still gets its own team accounts", async ({ request }) => {
    // Cheap insurance that the shared route file was edited additively — a TVT creation right
    // after several fpl-classic creations must behave exactly as it always has.
    await apiSignInSuperadmin(request);
    const tvt = await createTvtLeague(request, { teams: 8 });
    const db = testDb();
    const teamRows = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, tvt.id));
    expect(teamRows.length).toBe(8);
  });
});
