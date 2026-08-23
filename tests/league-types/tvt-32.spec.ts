/**
 * TVT-32 coverage spec.
 *
 * Format: 2 groups of 16 (groupCount=2 by default for 32-team), 2 reps per
 * group ⇒ 30 league-stage GWs, playoffs start at GW31. Playoff path includes
 * RO16 → QF → SF → Final plus the Challenger Cup (C-31 etc.).
 *
 * Run with: npm run test:e2e -- tests/league-types/tvt-32.spec.ts
 */

import { test, expect } from "@playwright/test";
import {
  apiSignInSuperadmin,
  apiSignInTeam,
  apiSignOut,
  createTvtLeague,
  generateFixtures,
  getFixtureStatus,
  setupAllTeams,
  ensureGameweeks,
  scoreGameweek,
  expectStandingsHasTeam,
  expectFixturesPageRenders,
  expectPageLoads,
  testDb,
  schema,
  type LeagueRef,
  type TeamHandle,
} from "../harness";
import { eq } from "drizzle-orm";

let league: LeagueRef;
let teams: TeamHandle[];

test.describe.serial("TVT-32 (admin + user)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000); // 32 teams × per-team setup HTTP calls
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 32 });
    teams = await setupAllTeams(request, league.slug, league.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    // Gameweeks must exist first — generate-fixtures rejects a league with no
    // league-stage gameweeks (it needs their deadlines to place fixtures).
    await ensureGameweeks(league.id);
    await generateFixtures(request, league.slug);
  });

  test("admin: league has 32 teams split across 2 groups", async () => {
    const db = testDb();
    const all = await db
      .select({ id: schema.teams.id, groupId: schema.teams.groupId })
      .from(schema.teams)
      .where(eq(schema.teams.leagueId, league.id));
    expect(all.length).toBe(32);
    const groups = new Set(all.map((t) => t.groupId).filter(Boolean));
    expect(groups.size).toBe(2);
  });

  test("admin: 32-team league has 30 league-stage GWs", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const status = await getFixtureStatus(request, league.slug);
    expect(status.leagueConfig?.teamSize).toBe(32);
    expect(status.leagueConfig?.groupCount).toBe(2);
    expect(status.leagueConfig?.playoffStartGw).toBe(31);
  });

  test("admin: groups reveal setting can be toggled", async ({ request }) => {
    await apiSignInSuperadmin(request);
    await request.post(`/api/admin/${league.slug}/settings`, {
      data: { key: "groupsRevealed", value: true },
    });
    const visible = await request.get(`/api/admin/${league.slug}/settings`).then((r) => r.json());
    expect(visible.groupsRevealed).toBe(true);
  });

  test("admin: generate-playoffs endpoint accepts a POST for the configured format", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const res = await request.post(`/api/admin/${league.slug}/generate-playoffs`, {
      failOnStatusCode: false,
    });
    // Without seeded standings we accept either success or a 400 with a
    // human-readable reason; the bracket generation itself is covered by
    // generate-brackets specs once standings exist.
    expect([200, 400]).toContain(res.status());
  });

  test("user: standings page lists at least one of the 32 teams", async ({ page }) => {
    // Standings show a placeholder until a match is played — score GW1 first.
    await scoreGameweek(league.id, 1, () => ({ home: 60, away: 50 }));
    await expectStandingsHasTeam(page, league.slug, teams[0].name);
  });

  test("user: fixtures page renders without error", async ({ page }) => {
    await expectFixturesPageRenders(page, league.slug);
  });

  test("user: winners + playoffs pages load (even before brackets seeded)", async ({ page }) => {
    await expectPageLoads(page, `/${league.slug}/winners`);
    await expectPageLoads(page, `/${league.slug}/playoffs`);
  });

  test("user: team can view its own dashboard after sign-in", async ({ request }) => {
    await apiSignInTeam(request, league.slug, 1);
    const dash = await request.get("/api/team/dashboard");
    expect(dash.ok()).toBeTruthy();
    await apiSignOut(request);
  });

  test("user: the dashboard carries a five-row table for BOTH groups", async ({ request }) => {
    // Only a two-group league exercises this; TVT-8 has one, so the rest of the
    // suite cannot cover it.
    await apiSignInTeam(request, league.slug, 1);
    const dash = await request.get("/api/team/dashboard");
    expect(dash.ok()).toBeTruthy();
    const body = await dash.json();
    await apiSignOut(request);

    const tables: {
      name: string;
      isMyGroup: boolean;
      truncated: boolean;
      rows: { rank: number; isCurrentTeam: boolean }[];
    }[] = body.groupTables;

    expect(tables.length, "a 32-team league is two groups").toBe(2);
    expect(tables[0].isMyGroup, "the viewer's own group comes first").toBe(true);
    expect(tables.filter((t) => t.isMyGroup).length).toBe(1);

    for (const table of tables) {
      expect(table.rows.length, `${table.name} row count`).toBeGreaterThan(0);
      expect(table.rows.length, `${table.name} is capped at five rows`).toBeLessThanOrEqual(5);

      // Always anchored to the top of the table — the bug in the old "window
      // around your team" behaviour was that it could omit the leaders entirely.
      expect(table.rows[0].rank, `${table.name} starts at the top`).toBe(1);

      const own = table.rows.filter((r) => r.isCurrentTeam);
      if (table.isMyGroup) {
        expect(own.length, "the viewer appears exactly once in their own group").toBe(1);
        const me = table.rows[table.rows.length - 1];
        if (table.truncated) {
          // Top four, then the viewer: ranks jump, and the viewer is last.
          expect(me.isCurrentTeam).toBe(true);
          expect(me.rank).toBeGreaterThan(5);
          expect(table.rows.slice(0, 4).map((r) => r.rank)).toEqual([1, 2, 3, 4]);
        } else {
          // Viewer is inside the top five, so it is a plain 1..n run.
          expect(table.rows.map((r) => r.rank)).toEqual(
            table.rows.map((_, i) => i + 1),
          );
        }
      } else {
        expect(own.length, "the other group must not contain the viewer").toBe(0);
        expect(table.truncated, "nothing to elide in a top-five list").toBe(false);
      }
    }
  });
});
