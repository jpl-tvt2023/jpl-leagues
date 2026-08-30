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
});
