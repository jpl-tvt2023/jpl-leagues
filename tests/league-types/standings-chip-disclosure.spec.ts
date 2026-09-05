/**
 * The public standings tooltip must not reveal a chip before its deadline.
 *
 * The CP/BP tooltip is built from every chip row in the league stage and rendered publicly for
 * every team as "Pending vs {opponent} GW{n}". A gameweek_chips row exists from the moment a chip
 * is DECLARED, and the tooltip had no deadline gate at all — so anyone could open the standings,
 * read that their next opponent had a Double Pointer lined up, or see a Challenge Chip's target,
 * and pick a captain against it. That is the exact leak /api/fixtures guards with its own
 * `deadline > now` check.
 *
 * The second test is the design point: the gate is applied at READ time, not baked into the
 * cached league-stage rows. Caching a time-dependent verdict is what hid the fixtures page's
 * chips for a full TTL, so here the chip must appear once its deadline passes WITHOUT anything
 * invalidating the cache.
 *
 * Run with: npm run test:e2e -- tests/league-types/standings-chip-disclosure.spec.ts
 */

import { test, expect } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  apiSignInSuperadmin, apiSignOut, setupAllTeams, ensureGameweeks,
  expireGameweek, invalidateLeagueCache, testDb, schema,
} from "../harness";

const TEAMS = 8;
/** Far enough out that its deadline is still ahead when the spec runs. */
const FUTURE_GW = 6;

let leagueId: string;
let slug: string;
let challengerName: string;
let challengedName: string;

type ChipEntry = { label: string; status: string; gameweek?: number; opponent?: string };

async function chipsFor(
  request: import("@playwright/test").APIRequestContext,
  teamName: string,
): Promise<ChipEntry[]> {
  const body = await request.get(`/api/standings?leagueSlug=${slug}`).then((r) => r.json());
  const rows = [...(body.groupA ?? []), ...(body.groupB ?? [])];
  const row = rows.find((r: { name: string }) => r.name === teamName);
  expect(row, `team ${teamName} should be in the standings`).toBeTruthy();
  return row.cbpTooltip.chips as ChipEntry[];
}

test.describe.serial("standings chip disclosure", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    slug = `scd-${Date.now().toString(36).slice(-5)}`;
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "Standings Chip Disclosure", sport: "fpl", format: "tvt",
        season: "2025-26", teamSize: TEAMS, groupCount: 2, enabledChips: ["D", "W", "C"],
      },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    leagueId = (await res.json()).id;

    await setupAllTeams(request, slug, TEAMS, "tvt");
    await ensureGameweeks(leagueId);
    await apiSignOut(request);

    const db = testDb();
    const [gw] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, FUTURE_GW))).limit(1);
    expect(gw, `GW${FUTURE_GW} should exist`).toBeTruthy();
    expect(gw.deadline.getTime(), "the planted gameweek must still be in the future")
      .toBeGreaterThan(Date.now());

    const teams = await db.select().from(schema.teams).where(eq(schema.teams.leagueId, leagueId));
    const groups = await db.select().from(schema.groups).where(eq(schema.groups.leagueId, leagueId));
    const inA = teams.filter((t) => t.groupId === groups.find((g) => g.name === "A")!.id);
    const inB = teams.filter((t) => t.groupId === groups.find((g) => g.name === "B")!.id);
    challengerName = inA[0].name;
    challengedName = inB[0].name;

    // A live, unplayed declaration — written straight to the table because the POST path gates
    // the Challenge Chip on rank, and what is under test is the read side.
    await db.insert(schema.gameweekChips).values({
      id: randomUUID(), gameweekId: gw.id, teamId: inA[0].id,
      chipType: "C", challengedTeamId: inB[0].id, isValid: true, isProcessed: false,
    });
    // Writing rows directly bypasses the handlers that would normally invalidate.
    await invalidateLeagueCache(leagueId);
  });

  test("a chip declared for a future gameweek is NOT disclosed", async ({ request }) => {
    const chips = await chipsFor(request, challengerName);
    const cc = chips.find((c) => c.label.startsWith("CC"));
    expect(cc, "the Challenge Chip slot should be present").toBeTruthy();

    // The leak: this used to be "pending", carrying the gameweek and the target's name.
    expect(cc!.status).toBe("available");
    expect(cc!.gameweek).toBeUndefined();
    expect(cc!.opponent).toBeUndefined();

    // And the target must not be named anywhere in the payload for this team.
    expect(JSON.stringify(chips)).not.toContain(challengedName);
  });

  test("once the deadline passes it IS disclosed — without invalidating the cache", async ({ request }) => {
    await expireGameweek(leagueId, FUTURE_GW);
    // Deliberately NO invalidateLeagueCache here. The gate runs at read time, so a warm cache
    // must not be able to keep the chip hidden — the failure mode this whole change is about.
    const chips = await chipsFor(request, challengerName);
    const cc = chips.find((c) => c.label.startsWith("CC"));

    expect(cc!.status).toBe("pending");
    expect(cc!.gameweek).toBe(FUTURE_GW);
    expect(cc!.opponent).toBe(challengedName);
  });
});
