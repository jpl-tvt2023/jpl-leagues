/**
 * Challenge Chip — the dashboard must remember WHO you challenged.
 *
 * Reported by a player: pick the Challenge Chip, pick an opponent, submit — and the
 * "Challenge against" dropdown snaps back to "Select opponent...". The chip itself still
 * showed as selected, so it read as though only the target had been lost.
 *
 * Nothing was actually lost. gameweek_chips.challenged_team_id was written correctly the
 * whole time; the dashboard payload just never sent it back, so the <select> had nothing to
 * restore itself from and every fresh mount started empty.
 *
 * The second test pins the nastier half. oppositeGroupTeams is recomputed from live standings
 * on every load, so a target that has since dropped out of its group's top 2 has no <option>
 * to match — and a <select> whose value matches no option renders blank, reproducing the exact
 * symptom through a different route. Here there are no standings at all, so that list is empty
 * and the fallback <option> is the only thing making the target visible.
 *
 * Run with: npm run test:e2e -- tests/league-types/challenge-chip-target-persists.spec.ts
 */

import { test, expect } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  apiSignInSuperadmin, apiSignInTeam, apiSignOut, setupAllTeams,
  ensureGameweeks, uiSignInTeam, testDb, schema,
} from "../harness";

const TEAMS = 8;

let leagueId: string;
let slug: string;
let challengerIndex: number;
let challengedName: string;

test.describe.serial("Challenge Chip target persists", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    slug = `cct-${Date.now().toString(36)}`;
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "Challenge Chip Target", sport: "fpl", format: "tvt",
        season: "2025-26", teamSize: TEAMS, groupCount: 2, enabledChips: ["D", "W", "C"],
      },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    leagueId = (await res.json()).id;

    await setupAllTeams(request, slug, TEAMS, "tvt");
    await ensureGameweeks(leagueId);

    const db = testDb();
    const [gw1] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, 1))).limit(1);
    const teams = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, leagueId));
    const groups = await db.select().from(schema.groups).where(eq(schema.groups.leagueId, leagueId));
    const inA = teams.filter((t) => t.groupId === groups.find((g) => g.name === "A")!.id);
    const inB = teams.filter((t) => t.groupId === groups.find((g) => g.name === "B")!.id);
    expect(inA.length, "league needs a populated Group A").toBeGreaterThan(0);
    expect(inB.length, "league needs a populated Group B").toBeGreaterThan(0);

    // Written straight to the table on purpose. The POST path gates the Challenge Chip on
    // rank, which needs a scored gameweek; what is under test is the read-back, so this
    // skips the setup that gate would otherwise demand.
    const challenger = inA[0];
    challengedName = inB[0].name;
    challengerIndex = teams.findIndex((t) => t.id === challenger.id) + 1;
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(), gameweekId: gw1.id, teamId: challenger.id,
      chipType: "C", challengedTeamId: inB[0].id,
    });
  });

  test("dashboard payload carries the challenged team", async ({ request }) => {
    await apiSignInTeam(request, slug, challengerIndex);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());

    expect(dash.upcomingChip).not.toBeNull();
    expect(dash.upcomingChip.type).toBe("C");
    expect(dash.upcomingChip.chipName).toBe("Challenge Chip");
    // The two fields the <select> had nothing to restore itself from.
    expect(dash.upcomingChip.challengedTeamId).toBeTruthy();
    expect(dash.upcomingChip.challengedTeamName).toBe(challengedName);
    await apiSignOut(request);
  });

  test("the opponent dropdown shows the challenged team, not 'Select opponent...'", async ({ page }) => {
    // uiSignInTeam already lands on /dashboard; an explicit goto races that in-flight
    // client navigation and aborts it.
    await uiSignInTeam(page, slug, challengerIndex);

    const opponent = page.locator("select").filter({ hasText: "Select opponent..." });
    await expect(opponent).toBeVisible({ timeout: 60_000 });

    // The reported symptom: this used to be "" (the placeholder option).
    await expect(opponent).toHaveValue(/.+/);
    const selectedLabel = await opponent.locator("option:checked").textContent();
    expect(selectedLabel?.trim()).toBe(challengedName);

    // And it survives a reload — the payload is the only source, so nothing here
    // depends on component state that a remount would throw away.
    await page.reload();
    await expect(opponent).toBeVisible({ timeout: 60_000 });
    expect((await opponent.locator("option:checked").textContent())?.trim()).toBe(challengedName);
  });
});
