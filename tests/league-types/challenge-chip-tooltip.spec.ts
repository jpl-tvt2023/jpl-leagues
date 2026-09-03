/**
 * Challenge Chip — tracking the challenge match from the fixtures tab.
 *
 * The Challenge Chip creates no fixture and stores no scoreline; the match is rebuilt from
 * each side's own regular result for that gameweek. These tests pin the user-visible half of
 * that: the pill appears on the challenger's REGULAR fixture card, and its tooltip opens on
 * TAP (not just hover, which does not exist on a phone) showing the rebuilt match.
 *
 * Run with: npm run test:e2e -- tests/league-types/challenge-chip-tooltip.spec.ts
 */

import { test, expect } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  apiSignInSuperadmin, setupAllTeams, ensureGameweeks, expireGameweek,
  generateFixtures, testDb, schema, invalidateLeagueCache,
} from "../harness";

const TEAMS = 8;
const GW = 2;
const CHALLENGER_SCORE = 214;
const CHALLENGED_SCORE = 186;

let leagueId: string;
let slug: string;
let challengerName: string;
let challengedName: string;
let challengerOpponentName: string;

/** Write a result WITH per-player JSON — the harness helper omits it, and the tooltip needs it. */
async function scoreFixture(
  fixtureId: string,
  homeTeamId: string,
  home: number,
  away: number,
  homeLabel: string,
  awayLabel: string,
) {
  const db = testDb();
  await db.delete(schema.results).where(eq(schema.results.fixtureId, fixtureId));
  const players = (label: string, total: number) =>
    JSON.stringify([
      { name: label + " P1", fplId: "1", fplScore: total - 40, transferHits: 0, isCaptain: false, finalScore: total - 40 },
      { name: label + " P2", fplId: "2", fplScore: 20, transferHits: 0, isCaptain: true, finalScore: 40 },
    ]);
  await db.insert(schema.results).values({
    id: randomUUID(),
    fixtureId,
    teamId: homeTeamId,
    homeScore: home,
    awayScore: away,
    homeMatchPoints: home > away ? 2 : home === away ? 1 : 0,
    awayMatchPoints: away > home ? 2 : home === away ? 1 : 0,
    homeGotBonus: false,
    awayGotBonus: false,
    homeUsedDoublePointer: false,
    awayUsedDoublePointer: false,
    homePlayerScores: players(homeLabel, home),
    awayPlayerScores: players(awayLabel, away),
  });
}

/** The fixtures page has no ?gw= param — the gameweek is chosen through GwNavigator. */
async function selectGw(page: import("@playwright/test").Page, gw: number) {
  const select = page.getByLabel("Gameweek", { exact: true });
  await select.waitFor({ state: "visible", timeout: 60_000 });
  await select.selectOption(String(gw));
}

test.describe.serial("Challenge Chip tooltip", () => {
  // Touch-capable context so the tap path can be driven with real touch events. Mouse still
  // works alongside it, so the hover test below is unaffected.
  test.use({ hasTouch: true });

  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    slug = "cct-" + Date.now().toString(36);
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "Challenge Chip Tooltip", sport: "fpl", format: "tvt",
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
    // The chip disclosure gate hides chips until the deadline passes.
    await expireGameweek(leagueId, GW);

    const db = testDb();
    const [gw] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, GW))).limit(1);
    const teamRows = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, leagueId));
    const groupRows = await db.select().from(schema.groups).where(eq(schema.groups.leagueId, leagueId));
    const teamById = new Map(teamRows.map((t) => [t.id, t]));
    const groupNameById = new Map(groupRows.map((g) => [g.id, g.name]));

    const gwFixtures = await db.select().from(schema.fixtures).where(eq(schema.fixtures.gameweekId, gw.id));
    expect(gwFixtures.length, "GW2 needs fixtures").toBeGreaterThan(0);

    // Challenger sits in Group A. The challenged team is in Group B, in a DIFFERENT fixture —
    // that separation is the point: the challenge is not the match on the card.
    const groupOf = (teamId: string) => groupNameById.get(teamById.get(teamId)!.groupId ?? "");
    const fxA = gwFixtures.find((f) => groupOf(f.homeTeamId) === "A");
    const fxB = gwFixtures.find((f) => groupOf(f.homeTeamId) === "B");
    expect(fxA, "need a Group A fixture in GW2").toBeTruthy();
    expect(fxB, "need a Group B fixture in GW2").toBeTruthy();

    challengerName = teamById.get(fxA!.homeTeamId)!.name;
    challengerOpponentName = teamById.get(fxA!.awayTeamId)!.name;
    challengedName = teamById.get(fxB!.homeTeamId)!.name;

    await scoreFixture(fxA!.id, fxA!.homeTeamId, CHALLENGER_SCORE, 150, challengerName, challengerOpponentName);
    await scoreFixture(fxB!.id, fxB!.homeTeamId, CHALLENGED_SCORE, 140, challengedName, "OppB");

    await db.insert(schema.gameweekChips).values({
      id: randomUUID(),
      gameweekId: gw.id,
      teamId: fxA!.homeTeamId,
      chipType: "C",
      challengedTeamId: fxB!.homeTeamId,
      isValid: true,
      isProcessed: true,
      pointsAwarded: 2,
    });
  });

  test("api rebuilds the challenge from both sides' own results", async ({ request }) => {
    const data = await request.get("/api/fixtures?leagueSlug=" + slug).then((r) => r.json());
    const chips = data.chipsByGameweek?.[GW];
    expect(chips, "chipsByGameweek should carry GW2").toBeTruthy();

    const entry = Object.values(chips as Record<string, Record<string, unknown>>)
      .find((c) => c.chipType === "C") as Record<string, unknown>;
    expect(entry).toBeTruthy();
    expect(entry.chipCode).toBe("CC");
    expect(entry.challengedTeamName).toBe(challengedName);

    const m = entry.challenge as Record<string, unknown>;
    expect(m, "challenge should be rebuilt once both sides are scored").toBeTruthy();
    expect(m.gameweek).toBe(GW);
    expect(m.challengerScore).toBe(CHALLENGER_SCORE);
    expect(m.challengedScore).toBe(CHALLENGED_SCORE);
    expect(m.outcome).toBe("won");
    expect(m.pointsAwarded).toBe(2);
  });

  test("a challenge never becomes a real fixture", async () => {
    // A challenge fixture would be counted by the league table and double-count the chip.
    const db = testDb();
    const all = await db.select().from(schema.fixtures);
    expect(all.some((f) => f.isChallenge)).toBe(false);
  });

  test("pill shows on the challenger's regular fixture card without expanding", async ({ page }) => {
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);
    const pill = page.getByText("CC", { exact: true }).first();
    await expect(pill).toBeVisible({ timeout: 60_000 });
    // Visible with every breakdown still collapsed.
    await expect(page.getByText("Hide breakdown")).toHaveCount(0);

    const card = page.locator("div").filter({ hasText: challengerName })
      .filter({ hasText: challengerOpponentName }).last();
    await expect(card.getByText("CC", { exact: true })).toBeVisible();
  });

  test("tapping the pill opens the challenge and does not toggle the breakdown", async ({ page }) => {
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);
    const pill = page.getByText("CC", { exact: true }).first();
    await expect(pill).toBeVisible({ timeout: 60_000 });

    // A real touch tap — hover does not exist on a phone, and this is the path that was
    // broken before (a tabIndex span does not reliably take focus on tap in iOS Safari).
    await pill.tap();

    const tip = page.getByRole("tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Challenge Chip");
    await expect(tip).toContainText("GW" + GW);
    await expect(tip).toContainText(String(CHALLENGER_SCORE));
    await expect(tip).toContainText(String(CHALLENGED_SCORE));
    await expect(tip).toContainText("Won the challenge");
    // Per-player rows, i.e. the same breakdown format as a normal fixture...
    await expect(tip).toContainText("P1");
    // ...but WITHOUT the TVT chip rows.
    await expect(tip).not.toContainText("TVT chips");
    // Chip-points wording, never league-fixture wording.
    await expect(tip).toContainText("does not count toward matches played");

    // The card's own click handler must not have fired.
    await expect(page.getByText("Hide breakdown")).toHaveCount(0);

    await tip.screenshot({ path: "test-results/challenge-chip-tooltip.png" });
  });

  test("hover still opens it for a mouse, and clicking does not close it", async ({ page }) => {
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);
    const pill = page.getByText("CC", { exact: true }).first();
    await expect(pill).toBeVisible({ timeout: 60_000 });

    await pill.hover();
    await expect(page.getByRole("tooltip")).toBeVisible();
    // Regression: a click used to toggle the tip shut immediately after hover opened it.
    await pill.click();
    await expect(page.getByRole("tooltip")).toBeVisible();
  });

  test("tooltip dismisses on Escape and on an outside tap", async ({ page }) => {
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);
    const pill = page.getByText("CC", { exact: true }).first();
    await expect(pill).toBeVisible({ timeout: 60_000 });

    await pill.tap();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await pill.tap();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await page.locator("h1").first().tap();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  });

  test("the GW2 challenge still reads GW2 after moving to another gameweek and back", async ({ page }) => {
    // The regression this guards: rendering the chip against the CURRENT gameweek (or live
    // data) instead of the one the chip was actually played in.
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, 3);
    await expect(page.getByText("Player breakdown").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("CC", { exact: true })).toHaveCount(0);

    await page.goto("/" + slug + "/fixtures", { waitUntil: "domcontentloaded" });
    await selectGw(page, GW);
    const pill = page.getByText("CC", { exact: true }).first();
    await expect(pill).toBeVisible({ timeout: 60_000 });
    await pill.tap();
    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("GW" + GW);
    await expect(tip).toContainText(String(CHALLENGER_SCORE));
  });

  /* ── live challenge, while the gameweek is still being played ──────────── */

  test("an unscored challenge shows the live scoreline instead of a bare team name", async ({ page, request }) => {
    // GW4 has fixtures but no results, so buildChallengeMatches cannot rebuild anything and
    // `chip.challenge` is null. The tooltip must still show both scorelines, assembled in the
    // browser from the live scores the page is already polling.
    const LIVE_GW = 4;
    const db = testDb();
    await apiSignInSuperadmin(request);
    await expireGameweek(leagueId, LIVE_GW);

    const [gw] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, LIVE_GW))).limit(1);
    const teamRows = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, leagueId));
    const groupRows = await db.select().from(schema.groups).where(eq(schema.groups.leagueId, leagueId));
    const teamById = new Map(teamRows.map((t) => [t.id, t]));
    const groupNameById = new Map(groupRows.map((g) => [g.id, g.name]));
    const groupOf = (teamId: string) => groupNameById.get(teamById.get(teamId)!.groupId ?? "");

    const gwFixtures = await db.select().from(schema.fixtures).where(eq(schema.fixtures.gameweekId, gw.id));
    const fxA = gwFixtures.find((f) => groupOf(f.homeTeamId) === "A")!;
    const fxB = gwFixtures.find((f) => groupOf(f.homeTeamId) === "B")!;
    expect(fxA && fxB, "need a fixture in each group for GW" + LIVE_GW).toBeTruthy();

    // Unprocessed on purpose: the chip has been played, the gameweek has not been scored.
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(),
      gameweekId: gw.id,
      teamId: fxA.homeTeamId,
      chipType: "C",
      challengedTeamId: fxB.homeTeamId,
      isValid: true,
      // The real shape of a played-but-unscored chip: points_awarded is NOT NULL and defaults
      // to 0, so "no points yet" is expressed by isProcessed alone.
      isProcessed: false,
      pointsAwarded: 0,
    });
    // This spec writes rows directly, so it must invalidate exactly as every API write path does.
    await invalidateLeagueCache(leagueId);

    // The API cannot rebuild it — that is the precondition this test exists for.
    const api = await request.get("/api/fixtures?leagueSlug=" + slug).then((r) => r.json());
    const liveEntry = Object.values(api.chipsByGameweek?.[LIVE_GW] ?? {})
      .find((c: any) => c.chipType === "C") as Record<string, unknown>;
    expect(liveEntry, "the chip is disclosed once its deadline passes").toBeTruthy();
    expect(liveEntry.challenge, "no stored result to rebuild from").toBeFalsy();
    // ...but it now carries the id the client needs to find the challenged side live.
    expect(liveEntry.challengedTeamId).toBe(fxB.homeTeamId);

    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, LIVE_GW);
    const pill = page.getByText("CC", { exact: true }).first();
    await expect(pill).toBeVisible({ timeout: 60_000 });

    // Wait for the live poll to land before opening the tip.
    await expect(page.getByText("LIVE", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await pill.tap();

    const tip = page.getByRole("tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Challenge Chip");
    await expect(tip).toContainText("GW" + LIVE_GW);
    await expect(tip).toContainText("LIVE");
    await expect(tip).toContainText("Challenge in progress");
    // Both team names, i.e. a real two-sided scoreline rather than the "challenging X" fallback.
    await expect(tip).toContainText(teamById.get(fxA.homeTeamId)!.name);
    await expect(tip).toContainText(teamById.get(fxB.homeTeamId)!.name);
    // Nothing may claim a result while the gameweek is still being played.
    await expect(tip).not.toContainText("Won the challenge");
    await expect(tip).not.toContainText("Lost the challenge");
    await expect(tip).toContainText("decided when the gameweek is scored");
  });

  test("a settled challenge is never redrawn from live data", async ({ page }) => {
    // GW2 is scored and GW4 is live. Selecting GW2 must still read GW2's stored scoreline,
    // with no LIVE badge inside the tooltip.
    await page.goto("/" + slug + "/fixtures");
    await selectGw(page, GW);
    const pill = page.getByText("CC", { exact: true }).first();
    await expect(pill).toBeVisible({ timeout: 60_000 });
    await pill.tap();

    const tip = page.getByRole("tooltip");
    await expect(tip).toContainText("GW" + GW);
    await expect(tip).toContainText(String(CHALLENGER_SCORE));
    await expect(tip).toContainText(String(CHALLENGED_SCORE));
    await expect(tip).toContainText("Won the challenge");
    await expect(tip).not.toContainText("Challenge in progress");
  });
});
