/**
 * A chip played in an earlier gameweek must stay spent.
 *
 * Reported by an admin: teams that had already played chips in past gameweeks were still
 * being offered them as "Available".
 *
 * The cause was that every read, and the submission guard itself, consulted
 * `teams.<chip>Set<N>Used` — columns nothing on the player's path ever wrote. POST
 * /api/team/chips inserted the chip row and returned; the scorer marked that row processed
 * without touching the team. Only the admin override/import routes ever set one to true. So
 * the columns stayed false for ever: the dashboard kept offering a spent chip, and the guard
 * reading the same columns kept accepting it — one chip could be played twice in a set.
 *
 * Usage is now derived from the chip rows, which is why these tests plant a row and never
 * touch the columns.
 *
 * Run with: npm run test:e2e -- tests/league-types/chip-used-in-past-gw.spec.ts
 */

import { test, expect } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  apiSignInSuperadmin, apiSignInTeam, apiSignOut, setupAllTeams,
  ensureGameweeks, testDb, schema,
} from "../harness";

const TEAMS = 8;
const TEAM_INDEX = 1;

let leagueId: string;
let slug: string;
/** A Set 1 gameweek that is NOT the open submission window. */
let playedGw: number;

test.describe.serial("Chip used in a past gameweek", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    slug = `cup-${Date.now().toString(36)}`;
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "Chip Used Past GW", sport: "fpl", format: "tvt",
        season: "2025-26", teamSize: TEAMS, groupCount: 2, enabledChips: ["D", "W", "C"],
      },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    leagueId = (await res.json()).id;

    await setupAllTeams(request, slug, TEAMS, "tvt");
    await ensureGameweeks(leagueId);

    // Find the open submission gameweek, then plant the played chip in a DIFFERENT Set 1
    // gameweek — the whole point is that a chip spent elsewhere in the set still counts.
    await apiSignInTeam(request, slug, TEAM_INDEX);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    const submissionGw: number = dash.submission.gameweek;
    expect(submissionGw, "league needs an open submission window").toBeGreaterThan(0);
    playedGw = submissionGw === 1 ? 2 : submissionGw - 1;
    await apiSignOut(request);

    const db = testDb();
    const [gw] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, playedGw))).limit(1);
    const teams = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, leagueId));
    const team = teams.find((t) => t.teamLoginId?.endsWith(String(TEAM_INDEX)))
      ?? teams[TEAM_INDEX - 1];

    // A Double Pointer played and scored — deliberately WITHOUT touching
    // teams.doublePointerSet1Used, which is what a real submission leaves behind.
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(), gameweekId: gw.id, teamId: team.id,
      chipType: "D", isValid: true, isProcessed: true, pointsAwarded: 2,
    });
  });

  test("the dashboard reports it as used, not available", async ({ request }) => {
    await apiSignInTeam(request, slug, TEAM_INDEX);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());

    // The reported symptom.
    expect(dash.chipStatus.set1.D.used).toBe(true);
    // And the picker must refuse it, with the reason a player can act on.
    expect(dash.chipEligibility.D.used).toBe(true);
    expect(dash.chipEligibility.D.eligible).toBe(false);
    expect(dash.chipEligibility.D.reason).toMatch(/already used in set 1/i);

    // Untouched chips in the same set stay available — the fix must not over-report.
    expect(dash.chipStatus.set1.W.used).toBe(false);
    expect(dash.chipEligibility.W.used).toBe(false);
    await apiSignOut(request);
  });

  test("submitting the same chip again in the set is rejected", async ({ request }) => {
    await apiSignInTeam(request, slug, TEAM_INDEX);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());

    const res = await request.post("/api/team/chips", {
      data: { chipType: "D", gameweek: dash.submission.gameweek },
      failOnStatusCode: false,
    });
    // Previously accepted: the guard read a column that was never written, so a team could
    // double-point twice in one set.
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/already been used for set 1/i);
    await apiSignOut(request);
  });

  test("a different chip in the same set is still allowed", async ({ request }) => {
    await apiSignInTeam(request, slug, TEAM_INDEX);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());

    const res = await request.post("/api/team/chips", {
      data: { chipType: "W", gameweek: dash.submission.gameweek },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    await apiSignOut(request);
  });
});
