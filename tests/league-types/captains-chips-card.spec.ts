/**
 * Dashboard "Captains & Chips" card.
 *
 * The card used to stack the chip badge UNDER the captain name, which made chip rows
 * taller than their neighbours and knocked Group A and Group B — two independent lists
 * in a grid — out of horizontal alignment. It also never surfaced who a Challenge Chip
 * had challenged, even though gameweek_chips.challenged_team_id stores it.
 *
 * Run with: npm run test:e2e -- tests/league-types/captains-chips-card.spec.ts
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
let challengerName: string;
let challengedName: string;

test.describe.serial("Captains & Chips card", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    slug = `cc-${Date.now().toString(36)}`;
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "Captains Chips Card", sport: "fpl", format: "tvt",
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
    const groupA = groups.find((g) => g.name === "A")!;
    const groupB = groups.find((g) => g.name === "B")!;
    const inA = teams.filter((t) => t.groupId === groupA.id);
    const inB = teams.filter((t) => t.groupId === groupB.id);
    expect(inA.length, "league needs a populated Group A").toBeGreaterThan(0);
    expect(inB.length, "league needs a populated Group B").toBeGreaterThan(0);

    // Captains on a subset, so the card also renders "not announced" rows.
    for (const t of [...inA.slice(0, 2), ...inB.slice(0, 2)]) {
      const [p] = await db.select().from(schema.players).where(eq(schema.players.teamId, t.id)).limit(1);
      if (!p) continue;
      await db.insert(schema.gameweekCaptains).values({
        id: randomUUID(), gameweekId: gw1.id, playerId: p.id, announcedAt: new Date(),
      });
    }

    // Chips written straight to the table: the write path has its own gate (the
    // Challenge Chip is rank-based and ineligible in GW1), and what's under test
    // here is the read/render path.
    challengerName = inA[0].name;
    challengedName = inB[0].name;
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(), gameweekId: gw1.id, teamId: inA[0].id,
      chipType: "C", challengedTeamId: inB[0].id,
    });
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(), gameweekId: gw1.id, teamId: inB[1].id, chipType: "W",
    });
  });

  test("api exposes the challenged team alongside the chip", async ({ request }) => {
    await apiSignInTeam(request, slug, 1);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    const challenger = dash.leagueCaptains.find((c: { teamName: string }) => c.teamName === challengerName);
    expect(challenger.chipType).toBe("C");
    expect(challenger.chipCode).toBe("CC");
    expect(challenger.chipName).toBe("Challenge Chip");
    expect(challenger.challengedTeamName).toBe(challengedName);

    const winwin = dash.leagueCaptains.find((c: { chipType: string }) => c.chipType === "W");
    expect(winwin.chipCode).toBe("WW");
    // Only the Challenge Chip carries a target.
    expect(winwin.challengedTeamName).toBeNull();
    await apiSignOut(request);
  });

  test("card renders headers, abbreviations, and aligned single-line rows", async ({ page }) => {
    // uiSignInTeam already lands on /dashboard; an explicit goto races that
    // in-flight client navigation and aborts it (net::ERR_ABORTED).
    await uiSignInTeam(page, slug, 1);

    const heading = page.getByRole("heading", { name: /Captains & Chips/ });
    await expect(heading).toBeVisible({ timeout: 60_000 });
    // The card root, not the inner header row — `.last()` on a bare div filter
    // resolves to the innermost match and screenshots only the title bar.
    const card = page.locator("div.rounded-2xl").filter({ has: heading }).first();

    // Column headers, one set per group column.
    await expect(page.getByText("Team", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Captain", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Chip", { exact: true }).first()).toBeVisible();

    // Abbreviation in the pill, not the full name.
    await expect(page.getByText("CC", { exact: true })).toBeVisible();
    await expect(page.getByText("WW", { exact: true })).toBeVisible();
    await expect(page.getByText("Challenge Chip", { exact: true })).toHaveCount(0);

    // The regression: a chip row was taller than its neighbours, so Group A and
    // Group B drifted apart vertically. Assert both halves of that directly.
    await expect(page.locator("li").filter({ hasText: challengerName }).first()).toBeVisible();

    const geometry = await page.evaluate(() => {
      const lists = Array.from(document.querySelectorAll("ul"))
        .filter((ul) => Array.from(ul.children).some((li) => getComputedStyle(li).display === "grid"));
      return lists.map((ul) =>
        Array.from(ul.children).map((li) => {
          const r = li.getBoundingClientRect();
          return { top: r.top, height: r.height };
        })
      );
    });

    expect(geometry.length, "expected one list per group column").toBe(2);
    const [colA, colB] = geometry;
    expect(colA.length).toBe(colB.length);

    // No row is materially taller than another. The stacked badge added ~20px; the
    // 1px that legitimately remains is `divide-y`, which borders every row but one.
    const heights = [...colA, ...colB].map((r) => r.height);
    expect(
      Math.max(...heights) - Math.min(...heights),
      `row heights varied: ${heights.map((h) => h.toFixed(2)).join(",")}`
    ).toBeLessThanOrEqual(1);

    // Row i of Group A sits level with row i of Group B.
    for (let i = 0; i < colA.length; i++) {
      expect(
        Math.abs(colA[i].top - colB[i].top),
        `row ${i} misaligned: A=${colA[i].top.toFixed(2)} B=${colB[i].top.toFixed(2)}`
      ).toBeLessThan(1);
    }

    // Tooltip names who was challenged. Hover is the desktop path; the tap path is covered
    // separately in challenge-chip-tooltip.spec.ts, because hover is exactly what does NOT
    // work on touch.
    await page.getByText("CC", { exact: true }).hover();
    await expect(page.getByRole("tooltip")).toContainText(`challenging ${challengedName}`);

    await card.screenshot({ path: "test-results/captains-chips-card.png" });
  });

  /* ── gameweek navigator ─────────────────────────────────────────────────── */

  test("the card defaults to the lowest unconcluded gameweek, not the last scored one", async ({ request }) => {
    await apiSignInTeam(request, slug, 1);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());

    // Nothing has concluded in this league, so the default is its first gameweek.
    expect(dash.captainsDefaultGw).toBe(1);
    expect(Array.isArray(dash.captainsAvailableGws)).toBe(true);
    // The range ends AT the default — the forward edge, never past it.
    expect(Math.max(...dash.captainsAvailableGws)).toBe(dash.captainsDefaultGw);
    expect(dash.captainsAvailableGws).toContain(1);
  });

  test("the captains route serves any gameweek inside the range", async ({ request }) => {
    await apiSignInTeam(request, slug, 1);
    const res = await request.get("/api/team/dashboard/captains?gw=1");
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.gameweek).toBe(1);
    expect(body.defaultGw).toBe(1);
    // Same shape the dashboard payload returns, so the card can swap one for the other.
    const challenger = body.leagueCaptains.find((c: { teamName: string }) => c.teamName === challengerName);
    expect(challenger.chipCode).toBe("CC");
    expect(challenger.challengedTeamName).toBe(challengedName);
    // Own team pinned first, exactly as the dashboard payload sorts it.
    expect(body.leagueCaptains[0].isOwnTeam).toBe(true);
  });

  test("a gameweek past the disclosure edge is REJECTED server-side", async ({ request }) => {
    // The gate that matters: a chip is written when DECLARED, which can be long before its
    // gameweek's deadline. Serving a future gameweek would hand a team their opponent's chip
    // before that opponent had to commit. A client-side clamp is not an access control, so the
    // server must refuse it outright.
    await apiSignInTeam(request, slug, 1);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    const beyond = dash.captainsDefaultGw + 1;

    const res = await request.get(`/api/team/dashboard/captains?gw=${beyond}`);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toContain(`GW${dash.captainsDefaultGw}`);
    // No announcements leak through the error body.
    expect(body.leagueCaptains).toBeUndefined();
  });

  test("the navigator renders and is bounded by the available range", async ({ page }) => {
    // uiSignInTeam already lands on /dashboard; an explicit goto races that in-flight client
    // navigation and aborts it (net::ERR_ABORTED).
    await uiSignInTeam(page, slug, 1);

    await expect(page.getByRole("heading", { name: /Captains & Chips/ })).toBeVisible({ timeout: 60_000 });
    const nav = page.getByLabel("Captains gameweek", { exact: true });
    await expect(nav).toBeVisible();
    await expect(nav).toHaveValue("1");

    // Only gameweeks up to the current one are offered — the disclosure edge, in the UI.
    const offered = await nav.locator("option").allTextContents();
    expect(offered).toEqual(["GW 1"]);
  });

  test("announcements require a session", async ({ request }) => {
    await apiSignOut(request);
    const res = await request.get("/api/team/dashboard/captains?gw=1");
    expect(res.status()).toBe(401);
  });

  /* ── advancing the default, and stepping back ───────────────────────────── */

  test("concluding GW1 moves the default to GW2 and opens GW1 to navigation", async ({ request }) => {
    // The rule under test: the card follows FPL's conclusion signal, so it moves to GW2 the
    // moment GW1 is over — it does not wait for our own scorer, and it does not jump to GW3.
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 1, liveGw: null } });
    await apiSignInTeam(request, slug, 1);

    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    expect(dash.captainsDefaultGw).toBe(2);
    expect(dash.captainsAvailableGws).toEqual([1, 2]);

    // GW1's announcements are still reachable...
    const back = await request.get("/api/team/dashboard/captains?gw=1");
    expect(back.status()).toBe(200);
    const backBody = await back.json();
    expect(backBody.gameweek).toBe(1);
    expect(
      backBody.leagueCaptains.find((c: { teamName: string }) => c.teamName === challengerName).chipCode,
    ).toBe("CC");

    // ...while GW2, the new default, carries none of GW1's chips.
    const fwd = await request.get("/api/team/dashboard/captains?gw=2").then((r) => r.json());
    expect(fwd.leagueCaptains.every((c: { chipCode: string | null }) => c.chipCode === null)).toBe(true);

    // And GW3 is still past the edge.
    expect((await request.get("/api/team/dashboard/captains?gw=3")).status()).toBe(400);
  });

  test("stepping the navigator back shows the earlier gameweek's chips", async ({ page }) => {
    await uiSignInTeam(page, slug, 1);
    await expect(page.getByRole("heading", { name: /Captains & Chips/ })).toBeVisible({ timeout: 60_000 });

    const nav = page.getByLabel("Captains gameweek", { exact: true });
    await expect(nav).toHaveValue("2");
    // GW2 has no chips, so the card shows no chip pill.
    await expect(page.getByText("CC", { exact: true })).toHaveCount(0);

    await nav.selectOption("1");
    await expect(page.getByText("CC", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // Forward again, back to the default — served from cache, and the pill goes away.
    await nav.selectOption("2");
    await expect(page.getByText("CC", { exact: true })).toHaveCount(0);
  });

  test.afterAll(async ({ request }) => {
    // Stub state is process-wide and deliberately persistent, so hand it back as we found it.
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: null } });
  });
});
