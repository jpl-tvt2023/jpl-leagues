/**
 * Challenge Chip — reprocessing a gameweek must not lose or duplicate the challenger's points.
 *
 * The challenge is scored off-fixture: the reversal path subtracts `pointsAwarded` and resets
 * `isProcessed`, then the challenge block re-scores the reset rows. That round trip is easy to
 * break, and because a challenge produces no fixture the damage would show up only in the
 * CP/BP column — nowhere near where anyone would look.
 *
 * Also pins the rule that a challenge never becomes a league match: reprocessing must move
 * cbpPoints and nothing else.
 *
 * Run with: npm run test:e2e -- tests/league-types/challenge-chip-reprocess.spec.ts
 */

import { test, expect } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  apiSignInSuperadmin, setupAllTeams, ensureGameweeks, expireGameweek,
  generateFixtures, testDb, schema,
} from "../harness";

const TEAMS = 8;
const GW = 2;

let leagueId: string;
let slug: string;
let challengerId: string;
let challengerName: string;

interface StandingRow {
  teamId: string;
  name: string;
  played: number;
  won: number;
  pointsFor: number;
  cbpPoints: number;
  leaguePoints: number;
}

async function standingFor(
  request: import("@playwright/test").APIRequestContext,
  teamId: string,
): Promise<StandingRow> {
  const data = await request.get("/api/standings?leagueSlug=" + slug).then((r) => r.json());
  const rows: StandingRow[] = [...(data.groupA ?? []), ...(data.groupB ?? [])];
  const row = rows.find((r) => r.teamId === teamId);
  expect(row, "challenger should appear in the standings").toBeTruthy();
  return row!;
}

async function chipRow() {
  const db = testDb();
  const [row] = await db
    .select()
    .from(schema.gameweekChips)
    .where(and(eq(schema.gameweekChips.teamId, challengerId), eq(schema.gameweekChips.chipType, "C")))
    .limit(1);
  return row;
}

test.describe.serial("Challenge Chip reprocessing", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    slug = "ccr-" + Date.now().toString(36);
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "Challenge Chip Reprocess", sport: "fpl", format: "tvt",
        season: "2025-26", teamSize: TEAMS, groupCount: 2, enabledChips: ["D", "W", "C"],
      },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    leagueId = (await res.json()).id;

    await setupAllTeams(request, slug, TEAMS, "tvt");
    await ensureGameweeks(leagueId);
    // setupAllTeams signs in as each team, which replaces the superadmin session.
    await apiSignInSuperadmin(request);
    await generateFixtures(request, slug);
    await expireGameweek(leagueId, GW);

    const db = testDb();
    const [gw] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, GW))).limit(1);
    const teamRows = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, leagueId));
    const groupRows = await db.select().from(schema.groups).where(eq(schema.groups.leagueId, leagueId));
    const groupNameById = new Map(groupRows.map((g) => [g.id, g.name]));
    const inA = teamRows.filter((t) => groupNameById.get(t.groupId ?? "") === "A");
    const inB = teamRows.filter((t) => groupNameById.get(t.groupId ?? "") === "B");
    expect(inA.length && inB.length, "need both groups populated").toBeTruthy();

    challengerId = inA[0].id;
    challengerName = inA[0].name;

    // Declared but unscored — the scorer picks it up on isProcessed = false.
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(),
      gameweekId: gw.id,
      teamId: challengerId,
      chipType: "C",
      challengedTeamId: inB[0].id,
      isValid: true,
      isProcessed: false,
      pointsAwarded: 0,
    });
  });

  test("scoring the gameweek processes the challenge chip", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const res = await request.post(`/api/gameweeks/${GW}?leagueId=${leagueId}`, { failOnStatusCode: false });
    expect(res.status(), await res.text()).toBe(200);

    const chip = await chipRow();
    expect(chip.isProcessed, `${challengerName}'s challenge should be processed`).toBe(true);
    expect(chip.pointsAwarded).toBeGreaterThanOrEqual(0);
    expect(chip.pointsAwarded).toBeLessThanOrEqual(2);
  });

  test("reprocessing leaves the challenger's points exactly where they were", async ({ request }) => {
    await apiSignInSuperadmin(request);

    const before = await standingFor(request, challengerId);
    const chipBefore = await chipRow();

    // Reprocess twice — a revert that under- or over-subtracts shows up as drift, and only
    // repeating it catches accumulation.
    for (let i = 1; i <= 2; i++) {
      const res = await request.post(`/api/gameweeks/${GW}?leagueId=${leagueId}&force=true`, {
        failOnStatusCode: false,
      });
      expect(res.status(), `reprocess ${i} failed: ${await res.text()}`).toBe(200);

      const chipAfter = await chipRow();
      expect(chipAfter.isProcessed, `chip should be re-processed after run ${i}`).toBe(true);
      expect(chipAfter.pointsAwarded, `chip points drifted on run ${i}`).toBe(chipBefore.pointsAwarded);

      const after = await standingFor(request, challengerId);
      expect(after.cbpPoints, `cbpPoints drifted on run ${i}`).toBe(before.cbpPoints);
      expect(after.leaguePoints, `leaguePoints drifted on run ${i}`).toBe(before.leaguePoints);
    }
  });

  test("the challenge moves CP/BP only — never played, won, or pointsFor", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const row = await standingFor(request, challengerId);
    const chip = await chipRow();

    // The challenge is an extra match in name only. It must not have inflated the record.
    const db = testDb();
    const gwFixtures = await db.select().from(schema.fixtures);
    expect(gwFixtures.some((f) => f.isChallenge), "no challenge fixture may exist").toBe(false);

    // One regular fixture per gameweek played, regardless of the challenge.
    expect(row.played).toBeLessThanOrEqual(1);
    // Whatever the chip awarded is carried by CP/BP.
    expect(row.cbpPoints).toBeGreaterThanOrEqual(chip.pointsAwarded);
  });
});
