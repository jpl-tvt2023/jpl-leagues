/**
 * FPL chips on the public fixtures page.
 *
 * Two things this pins:
 *
 *  1. A manager's official FPL chip (Wildcard, Bench Boost, Triple Captain, Free Hit, Assistant
 *     Manager) shows next to their name in the player breakdown, with an affordance telling the
 *     reader to tap or hover it for details — the fixtures page had never shown these before.
 *  2. When that clashes with the team's TVT chip, the TVT chip pill reads WASTED with a reason,
 *     both in the raw API payload (which used to hide wasted chips outright) and on the page.
 *
 * A manager whose FPL history was never fetched must render as nothing — not a placeholder, not
 * an error — because this route is cache-only and a cold cache is the ordinary state here.
 *
 * Run with: npm run test:e2e -- tests/league-types/fpl-chips-fixtures.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  apiSignInSuperadmin, setupAllTeams, ensureGameweeks, expireGameweek,
  generateFixtures, testDb, schema, invalidateLeagueCache, uniqueSlug,
} from "../harness";

const TEAMS = 8;
const GW = 2;

let leagueId: string;
let slug: string;
let chipTeamId: string;
let chipTeamName: string;
let opponentName: string;
let chipFixtureId: string;
let chipTeamFplIds: string[];
let chipTeamPlayerNames: string[];

/** The fixtures page has no ?gw= param — the gameweek is chosen through GwNavigator. */
async function selectGw(page: Page, gw: number) {
  const select = page.getByLabel("Gameweek", { exact: true });
  await select.waitFor({ state: "visible", timeout: 60_000 });
  await select.selectOption(String(gw));
}

async function setFplChips(request: APIRequestContext, overrides: Record<string, { name: string; event: number }[]>) {
  const res = await request.post("/api/test-fpl-stub/control", { data: { chipOverrides: overrides } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function scoreGw(request: APIRequestContext) {
  await apiSignInSuperadmin(request);
  const res = await request.post(`/api/gameweeks/${GW}?leagueId=${leagueId}`, { failOnStatusCode: false });
  expect(res.status(), await res.text()).toBe(200);
}

test.describe.serial("FPL chips on the fixtures page", () => {
  // Touch-capable context so the pills' tap path (real touch events, not a synthetic click) is
  // exercised — the same reason challenge-chip-tooltip.spec.ts sets this.
  test.use({ hasTouch: true });

  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    slug = "fcf-" + Date.now().toString(36);
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "FPL Chips Fixtures", sport: "fpl", format: "tvt",
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
    const gwFixtures = await db.select().from(schema.fixtures).where(eq(schema.fixtures.gameweekId, gw.id));
    expect(gwFixtures.length, "GW2 needs fixtures").toBeGreaterThan(0);

    const teamRows = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, leagueId));
    const teamById = new Map(teamRows.map((t) => [t.id, t]));

    const fx = gwFixtures[0];
    chipTeamId = fx.homeTeamId;
    chipTeamName = teamById.get(fx.homeTeamId)!.name;
    opponentName = teamById.get(fx.awayTeamId)!.name;
    chipFixtureId = fx.id;

    const playerRows = await db.select().from(schema.players).where(eq(schema.players.teamId, chipTeamId));
    expect(playerRows.length, "a TVT team has two managers").toBeGreaterThan(1);
    chipTeamFplIds = playerRows.map((p) => p.fplId);
    chipTeamPlayerNames = playerRows.map((p) => p.name);

    // Declared but unscored — the scorer picks it up on isProcessed = false.
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(),
      gameweekId: gw.id,
      teamId: chipTeamId,
      chipType: "D",
      isValid: true,
      isProcessed: false,
      pointsAwarded: 0,
    });

    // A rejected declaration in the SAME gameweek — never played, must stay hidden even though
    // wasted chips are no longer hidden. This is the one case isChipDisclosable still excludes.
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(),
      gameweekId: gw.id,
      teamId: fx.awayTeamId,
      chipType: "W",
      isValid: false,
      isProcessed: false,
      pointsAwarded: 0,
      validationErrors: "Rejected at submission",
    });

    // Only the first manager plays an FPL chip. The rule is team-wide, so this alone wastes it.
    await setFplChips(request, {
      [chipTeamFplIds[0]]: [{ name: "bboost", event: GW }],
      [chipTeamFplIds[1]]: [],
    });
    await scoreGw(request);
    // Scoring runs through the API route directly (not the DB), so the page's own cache must be
    // dropped exactly as every write path already does — same trap as the tooltip spec hit.
    await invalidateLeagueCache(leagueId);
  });

  test.afterAll(async ({ request }) => {
    await request.post("/api/test-fpl-stub/control", { data: { chipOverrides: {} } });
  });

  test("API: the wasted chip is disclosed, and the rejected one is not", async ({ request }) => {
    const data = await request.get("/api/fixtures?leagueSlug=" + slug).then((r) => r.json());
    const chips = data.chipsByGameweek?.[GW];
    expect(chips, "chipsByGameweek should carry GW2").toBeTruthy();

    const entry = chips[chipTeamId];
    expect(entry, "the wasted chip must still be disclosed").toBeTruthy();
    expect(entry.isWasted).toBe(true);
    expect(entry.wastedReason).toContain("Bench Boost");
    expect(entry.wastedReason).toContain("Double Pointer");

    // The rejected Win-Win declaration never played — must not appear at all.
    const allEntries = Object.values(chips as Record<string, { chipType: string }>);
    expect(allEntries.some((c) => c.chipType === "W")).toBe(false);
  });

  test("API: fplChipsByFplId and playersByTeamId carry what the page needs", async ({ request }) => {
    const data = await request.get("/api/fixtures?leagueSlug=" + slug).then((r) => r.json());

    const status = data.fplChipsByFplId?.[chipTeamFplIds[0]];
    expect(status, "cached history for the manager who played BB").toBeTruthy();
    expect(status.used).toEqual([{ code: "BB", gw: GW }]);

    const roster = data.playersByTeamId?.[chipTeamId];
    expect(roster?.map((p: { fplId: string }) => p.fplId).sort()).toEqual([...chipTeamFplIds].sort());
  });

  test("page: FPL chip pill, the tap/hover hint, and the wasted TVT badge all render", async ({ page }) => {
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);

    const card = page.getByTestId(`fixture-card-${chipFixtureId}`);
    await expect(card).toBeVisible({ timeout: 60_000 });

    // The TVT pill: struck through, carrying a "Wasted" badge.
    const wastedBadge = card.getByText("Wasted", { exact: true });
    await expect(wastedBadge).toBeVisible();

    // Expand the breakdown to reach the FPL chip pill.
    await card.getByText("Player breakdown").click();
    await expect(card.getByText("Hide breakdown")).toBeVisible();

    await expect(card.getByText("Tap or hover a chip")).toBeVisible();
    const bbPill = card.getByText("BB", { exact: false }).first();
    await expect(bbPill).toBeVisible();
  });

  test("a chip played in a DIFFERENT gameweek does not appear on this one", async ({ request, page }) => {
    // The regression this guards: the breakdown used to render all six FPL chips for every
    // manager, each carrying the gameweek it was spent in — so a wildcard played in GW5 showed up
    // as "WC1 5" on the GW2 card, alongside four green "available" pills. Only chips played in the
    // gameweek on screen belong here.
    await setFplChips(request, {
      [chipTeamFplIds[0]]: [
        { name: "bboost", event: GW },        // this gameweek — must show
        { name: "wildcard", event: GW + 3 },  // a later gameweek — must NOT show
      ],
    });

    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);
    const card = page.getByTestId(`fixture-card-${chipFixtureId}`);
    await card.getByText("Player breakdown").click();
    await expect(card.getByText("Hide breakdown")).toBeVisible();

    await expect(card.getByText("BB", { exact: true }).first()).toBeVisible();
    // Neither the bare code nor the old "WC1 5" form.
    await expect(card.getByText("WC1", { exact: false })).toHaveCount(0);
    // And no inventory pills for chips that were never played at all.
    await expect(card.getByText("TC", { exact: false })).toHaveCount(0);
    await expect(card.getByText("FH", { exact: false })).toHaveCount(0);

    // Restore the fixture's expected chip state for the tests that follow.
    await setFplChips(request, { [chipTeamFplIds[0]]: [{ name: "bboost", event: GW }] });
  });

  test("page: tapping the FPL chip pill names it", async ({ page }) => {
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);

    const card = page.getByTestId(`fixture-card-${chipFixtureId}`);
    await card.getByText("Player breakdown").click();

    const bbPill = card.getByText("BB", { exact: false }).first();
    await bbPill.tap();
    await expect(page.getByRole("tooltip")).toContainText("Bench Boost");
  });

  test("page: tapping the wasted TVT pill explains why", async ({ page }) => {
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);

    const card = page.getByTestId(`fixture-card-${chipFixtureId}`);
    // "DP" is the Double Pointer pill code, struck through next to the team name.
    const dPill = card.getByText("DP", { exact: true }).first();
    await dPill.tap();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("Bench Boost");
    await expect(tip).toContainText("Double Pointer");
  });

  test("a manager whose FPL history was never fetched renders no chip and no placeholder", async ({ request, page }) => {
    // A fresh league: nothing has ever scored a gameweek or warmed the FPL-league page for it, so
    // no manager's history is cached. This is the ordinary cold state for a public reader arriving
    // before anyone has triggered a fetch — it must render as absence, not as an error.
    await apiSignInSuperadmin(request);
    // Short prefix: /api/team/setup caps loginId (slug + "-TeamN") at 20 chars.
    const coldSlug = uniqueSlug("fcfc");
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug: coldSlug, name: "FPL Chips Cold Cache", sport: "fpl", format: "tvt",
        season: "2025-26", teamSize: TEAMS, groupCount: 2, enabledChips: ["D", "W", "C"],
      },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    const coldLeagueId = (await res.json()).id;

    // A distinct fplBase, not the harness default of 1000: every spec that never overrides it
    // shares that same 1000-range, so this league's managers would otherwise collide with — and
    // inherit the cached history of — managers from the OTHER league already scored above (or
    // from any other spec's default-fplBase league, since Redis history persists across runs).
    // The whole point of this test is a manager nobody has ever fetched.
    await setupAllTeams(request, coldSlug, TEAMS, "tvt", { fplBase: 900_000 + (Date.now() % 90_000) });
    await ensureGameweeks(coldLeagueId);
    await apiSignInSuperadmin(request);
    await generateFixtures(request, coldSlug);
    await expireGameweek(coldLeagueId, GW);

    const db = testDb();
    const [gw] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, coldLeagueId), eq(schema.gameweeks.number, GW))).limit(1);
    const gwFixtures = await db.select().from(schema.fixtures).where(eq(schema.fixtures.gameweekId, gw.id));
    const fx = gwFixtures[0];

    await db.insert(schema.gameweekChips).values({
      id: randomUUID(),
      gameweekId: gw.id,
      teamId: fx.homeTeamId,
      chipType: "W",
      isValid: true,
      isProcessed: false,
      pointsAwarded: 0,
    });
    await invalidateLeagueCache(coldLeagueId);

    const data = await request.get("/api/fixtures?leagueSlug=" + coldSlug).then((r) => r.json());
    const roster = await db.select().from(schema.players).where(eq(schema.players.teamId, fx.homeTeamId));
    for (const p of roster) {
      expect(data.fplChipsByFplId?.[p.fplId], "no history has been fetched for this manager").toBeUndefined();
    }

    await page.goto("/" + coldSlug + "/fixtures");
    await selectGw(page, GW);
    const card = page.getByTestId(`fixture-card-${fx.id}`);
    await card.getByText("Player breakdown").click();

    // No native placeholder, no crash — the FPL chip row is simply absent.
    await expect(card.getByText("FPL chips unavailable")).toHaveCount(0);
  });

  test("chip team roster was captured from the DB, not guessed", async () => {
    // Sanity: if this list is ever empty the setup itself is broken rather than the feature.
    expect(chipTeamPlayerNames.length).toBeGreaterThan(1);
  });
});
