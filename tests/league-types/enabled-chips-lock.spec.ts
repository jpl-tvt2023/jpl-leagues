/**
 * A league's chip set is fixed for the season.
 *
 * The three chips are agreed before kick-off and never swapped mid-season. That was a convention
 * held outside the code; these tests cover the guard that now enforces it.
 *
 * Why it has to be enforced rather than trusted: `enabledChips` holds exactly three codes, so a
 * change is always a SWAP, and the chip leaving may already have been played. `/api/fixtures` and
 * `/api/standings` both filter chip HISTORY by the CURRENT set, while
 * `lib/standings/league-stage.ts` sums `pointsAwarded` with no such filter — so a mid-season swap
 * would leave a team's points in the table with nothing on screen accounting for them, silently.
 * The guard is what makes that read-time filtering safe.
 *
 * Run with: npm run test:e2e -- tests/league-types/enabled-chips-lock.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  apiSignInSuperadmin,
  ensureGameweeks,
  expireGameweek,
  testDb,
  schema,
  uniqueSlug,
} from "../harness";

const TEAMS = 8;

async function createTvtLeague(request: APIRequestContext, slug: string): Promise<string> {
  const res = await request.post("/api/superadmin/leagues", {
    data: {
      slug,
      name: "Chip Lock",
      sport: "fpl",
      format: "tvt",
      season: "2025-26",
      teamSize: TEAMS,
      groupCount: 2,
      enabledChips: ["D", "W", "C"],
    },
    failOnStatusCode: false,
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).id as string;
}

async function patchChips(request: APIRequestContext, leagueId: string, chips: string[]) {
  return request.patch(`/api/superadmin/leagues/${leagueId}`, {
    data: { enabledChips: chips },
    failOnStatusCode: false,
  });
}

async function storedChips(leagueId: string): Promise<string[]> {
  const db = testDb();
  const [row] = await db
    .select({ enabledChips: schema.leagues.enabledChips })
    .from(schema.leagues)
    .where(eq(schema.leagues.id, leagueId))
    .limit(1);
  return JSON.parse(row?.enabledChips ?? "[]");
}

test.describe.serial("enabledChips is fixed for the season", () => {
  test("before kick-off the chip set can still be corrected", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const leagueId = await createTvtLeague(request, uniqueSlug("ecl-a"));
    // Deliberately NOT calling ensureGameweeks: no gameweeks means no passed deadline and no
    // declarations, which is exactly the pre-kick-off state the rule leaves open.
    const res = await patchChips(request, leagueId, ["D", "W", "SL"]);

    expect(res.status(), await res.text()).toBe(200);
    expect(await storedChips(leagueId)).toEqual(["D", "W", "SL"]);
  });

  test("once a deadline has passed the chip set is locked", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const leagueId = await createTvtLeague(request, uniqueSlug("ecl-b"));
    await ensureGameweeks(leagueId);
    await expireGameweek(leagueId, 1);

    const res = await patchChips(request, leagueId, ["D", "W", "SL"]);

    expect(res.status()).toBe(409);
    expect((await res.json()).error).toContain("GW1");
    // The rejection must be total — a 409 that still wrote would be worse than no guard.
    expect(await storedChips(leagueId)).toEqual(["D", "W", "C"]);
  });

  test("a declared chip locks the set even before any deadline passes", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const leagueId = await createTvtLeague(request, uniqueSlug("ecl-c"));
    await ensureGameweeks(leagueId);

    // A declaration for a gameweek still in the future. No deadline has passed, so this is the
    // condition the deadline check alone would miss — and swapping the chip out would leave this
    // row undeclarable and invisible.
    const db = testDb();
    const [gw] = await db
      .select({ id: schema.gameweeks.id })
      .from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, 5)))
      .limit(1);
    const [team] = await db
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.leagueId, leagueId))
      .limit(1);
    test.skip(!team, "league factory created no teams — nothing to declare a chip for");

    await db.insert(schema.gameweekChips).values({
      id: randomUUID(),
      teamId: team.id,
      gameweekId: gw.id,
      chipType: "C",
      isValid: true,
      isProcessed: false,
      pointsAwarded: 0,
    });

    const res = await patchChips(request, leagueId, ["D", "W", "SL"]);

    expect(res.status()).toBe(409);
    expect((await res.json()).error).toContain("declared");
    expect(await storedChips(leagueId)).toEqual(["D", "W", "C"]);
  });

  test("the lock is specific to chips — a started league can still be renamed", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const leagueId = await createTvtLeague(request, uniqueSlug("ecl-d"));
    await ensureGameweeks(leagueId);
    await expireGameweek(leagueId, 1);

    // The guard sits inside the `enabledChips !== undefined` branch, so an edit that does not
    // touch chips must be unaffected. The superadmin UI relies on this: it seeds the form with
    // the league's real chips and sends them only when they actually changed.
    const res = await request.patch(`/api/superadmin/leagues/${leagueId}`, {
      data: { name: "Renamed Mid-Season" },
      failOnStatusCode: false,
    });

    expect(res.status(), await res.text()).toBe(200);
    const db = testDb();
    const [row] = await db
      .select({ name: schema.leagues.name })
      .from(schema.leagues)
      .where(eq(schema.leagues.id, leagueId))
      .limit(1);
    expect(row.name).toBe("Renamed Mid-Season");
  });

  test("the leagues list reports the lock, so the UI and the guard agree", async ({ request }) => {
    await apiSignInSuperadmin(request);
    const openSlug = uniqueSlug("ecl-e");
    const lockedSlug = uniqueSlug("ecl-f");
    const openId = await createTvtLeague(request, openSlug);
    const lockedId = await createTvtLeague(request, lockedSlug);
    await ensureGameweeks(lockedId);
    await expireGameweek(lockedId, 1);

    const body = await request.get("/api/superadmin/leagues").then((r) => r.json());
    const open = body.leagues.find((l: { id: string }) => l.id === openId);
    const locked = body.leagues.find((l: { id: string }) => l.id === lockedId);

    expect(open.chipsLockedReason, "a pre-kick-off league is editable").toBeNull();
    expect(locked.chipsLockedReason, "a started league is locked").toContain("GW1");
    // The edit dialog seeds its checkboxes from this, so it must be present and parseable.
    expect(JSON.parse(open.enabledChips)).toEqual(["D", "W", "C"]);
  });
});
