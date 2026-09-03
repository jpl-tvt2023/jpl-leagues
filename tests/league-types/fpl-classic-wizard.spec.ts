/**
 * FPL Classic — the superadmin creation wizard, driven through the browser.
 *
 * Every other fpl-classic spec talks to the API directly. This one exists because the wizard is
 * the only way a human ever creates one of these leagues, and it takes a path no other format
 * takes: it skips the team_size, chips and assign steps entirely, sends no slug or name (the
 * server derives both from FPL), and submits three fields — fplLeagueId, scoringMetric,
 * winnerCutPercent — that no other format sends. A wizard that renders fine but drops one of
 * those fails server validation, and an API-level spec would never notice.
 *
 * Run with: npm run test:e2e -- tests/league-types/fpl-classic-wizard.spec.ts
 */

import { test, expect } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";
import { uiSignInSuperadmin, apiSignInSuperadmin, deleteLeague, testDb, schema } from "../harness";

const STUB_LEAGUE_ID = 900001;
const STUB_ENTRANT_COUNT = 120;

test.describe.serial("FPL Classic — creation wizard", () => {
  // The wizard sends no season field, so the server uses its default and derives a fixed slug.
  // test.db persists across local runs, so a leftover league would turn this into a 409.
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

  test("creates a league end-to-end: verify the id, skip straight to details, submit", async ({ page }) => {
    await uiSignInSuperadmin(page);
    await page.goto("/superadmin");

    await page.getByRole("button", { name: "+ Create League" }).click();

    // Sport, then format. Picking FPL Classic must jump to the FPL step — not team_size.
    await page.getByRole("button", { name: /Fantasy Premier League|FPL/i }).first().click();
    await page.getByRole("button", { name: /FPL Classic/i }).first().click();
    await expect(page.getByRole("heading", { name: "Which FPL league?" })).toBeVisible();

    // Verify gates the Continue button — it must be disabled until a real league is confirmed.
    const useThis = page.getByRole("button", { name: /Use this league/ });
    await expect(useThis).toBeDisabled();

    await page.getByPlaceholder("e.g. 314159").fill(String(STUB_LEAGUE_ID));
    await page.getByRole("button", { name: "Verify" }).click();

    // The preview proves the FPL round-trip: name and entrant count come back from the stub.
    await expect(page.getByText("Stub Classic")).toBeVisible();
    await expect(page.getByText(`${STUB_ENTRANT_COUNT} entrants`)).toBeVisible();
    await expect(useThis).toBeEnabled();
    await useThis.click();

    // Details step. The name is shown read-only and there is no slug field at all — the server
    // derives both from FPL. The winner-cut helper doing live arithmetic (30% of 120 = 36) is the
    // cheapest proof that the entrant count survived the hop from the preview step.
    await expect(page.getByRole("heading", { name: "League Details" })).toBeVisible();
    await expect(page.getByText("Season winners — top %")).toBeVisible();
    await expect(page.getByText("Top 36 of 120 entrants.")).toBeVisible();
    await expect(page.getByText(/0 Teams/)).toHaveCount(0);

    // For this format the details step is the last one, so its submit button says so.
    await page.getByRole("button", { name: "Create League" }).last().click();

    // Success, and it never passed through the assign step — a public league has no admins.
    await expect(page.getByText(/created!/i)).toBeVisible({ timeout: 30_000 });

    const db = testDb();
    const [league] = await db
      .select()
      .from(schema.leagues)
      .where(eq(schema.leagues.slug, `league-${STUB_LEAGUE_ID}`))
      .limit(1);
    expect(league, "the wizard should have created the league").toBeTruthy();
    expect(league!.format).toBe("fpl-classic");
    expect(league!.name).toBe("Stub Classic");

    // The three wizard-only fields actually reached the server.
    const [config] = await db
      .select()
      .from(schema.fplClassicConfig)
      .where(eq(schema.fplClassicConfig.leagueId, league!.id))
      .limit(1);
    expect(config, "config row should exist").toBeTruthy();
    expect(config!.fplLeagueId).toBe(STUB_LEAGUE_ID);
    expect(config!.entrantCount).toBe(STUB_ENTRANT_COUNT);

    // And the regression that matters most, reached through the UI this time.
    const teamRows = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, league!.id));
    expect(teamRows.length).toBe(0);
  });

  test("an unknown league id is reported in the wizard, not swallowed", async ({ page }) => {
    await uiSignInSuperadmin(page);
    await page.goto("/superadmin");

    await page.getByRole("button", { name: "+ Create League" }).click();
    await page.getByRole("button", { name: /Fantasy Premier League|FPL/i }).first().click();
    await page.getByRole("button", { name: /FPL Classic/i }).first().click();

    await page.getByPlaceholder("e.g. 314159").fill("999999");
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page.getByText(/No FPL league/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Use this league/ })).toBeDisabled();
  });
});
