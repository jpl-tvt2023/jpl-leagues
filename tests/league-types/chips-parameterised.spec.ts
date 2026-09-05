/**
 * The chip picker follows the league's enabledChips.
 *
 * A league may enable any three of D/W/C/SL/CB/UD, but the dashboard hardcoded a D/C/W
 * picker and PlFixtureCard hardcoded a DP/CC/WW badge row. On a league running SL/CB/UD that
 * was not a cosmetic mismatch — it was total breakage: the picker offered three chips and
 * POST /api/team/chips rejected every one of them as "not enabled for this league", so the
 * team could not play a chip at all.
 *
 * Scoring is the other half. api/gameweeks/[gw] only processes W, D and C; SL/CB/UD score
 * nothing, so they are surfaced as ineligible rather than offered — playing one would burn
 * the set slot for no points. See IMPLEMENTED_TVT_CHIPS in lib/formats/tvt/chip-labels.ts.
 *
 * Run with: npm run test:e2e -- tests/league-types/chips-parameterised.spec.ts
 */

import { test, expect } from "@playwright/test";
import {
  apiSignInSuperadmin, apiSignInTeam, apiSignOut, setupAllTeams, ensureGameweeks,
} from "../harness";

const TEAMS = 8;

let seq = 0;

// The harness builds team logins as `${slug}-Team${i}`, and the setup route caps team ids at
// 20 chars — so the slug has to stay short enough to leave room for the suffix.
async function createLeague(
  request: import("@playwright/test").APIRequestContext,
  tag: string,
  enabledChips: string[],
) {
  await apiSignInSuperadmin(request);
  const slug = `cp${tag}${seq++}-${Date.now().toString(36).slice(-5)}`;
  const res = await request.post("/api/superadmin/leagues", {
    data: {
      slug, name: `Chips ${enabledChips.join("/")}`, sport: "fpl", format: "tvt",
      season: "2025-26", teamSize: TEAMS, groupCount: 2, enabledChips,
    },
    failOnStatusCode: false,
  });
  expect(res.status(), await res.text()).toBe(200);
  const leagueId = (await res.json()).id;
  await setupAllTeams(request, slug, TEAMS, "tvt");
  await ensureGameweeks(leagueId);
  await apiSignOut(request);
  return { slug, leagueId };
}

test.describe.serial("chip picker follows enabledChips", () => {
  test("a default D/W/C league reports exactly those three", async ({ request }) => {
    const { slug } = await createLeague(request, "a", ["D", "W", "C"]);
    await apiSignInTeam(request, slug, 1);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());

    expect([...dash.enabledChips].sort()).toEqual(["C", "D", "W"]);
    expect(Object.keys(dash.chipEligibility).sort()).toEqual(["C", "D", "W"]);
    // Status maps are keyed by chip code now, not doublePointer/challengeChip/winWin.
    expect(Object.keys(dash.chipStatus.set1).sort()).toEqual(["C", "D", "W"]);
    // Win-Win has no extra rule, so on an open window it is offerable.
    expect(dash.chipEligibility.W.used).toBe(false);
    await apiSignOut(request);
  });

  test("an SL/CB/UD league reports its own chips, not D/C/W", async ({ request }) => {
    const { slug } = await createLeague(request, "b", ["SL", "CB", "UD"]);
    await apiSignInTeam(request, slug, 1);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());

    expect([...dash.enabledChips].sort()).toEqual(["CB", "SL", "UD"]);
    expect(Object.keys(dash.chipEligibility).sort()).toEqual(["CB", "SL", "UD"]);
    expect(Object.keys(dash.chipStatus.set1).sort()).toEqual(["CB", "SL", "UD"]);
    // The chips this league does NOT run must not appear at all — offering them was the
    // bug, since the submit route rejects every one of them.
    expect(dash.chipEligibility.D).toBeUndefined();
    expect(dash.chipEligibility.W).toBeUndefined();
    await apiSignOut(request);
  });

  test("unimplemented chips are surfaced as ineligible, not silently offered", async ({ request }) => {
    const { slug } = await createLeague(request, "b", ["SL", "CB", "UD"]);
    await apiSignInTeam(request, slug, 1);
    const dash = await request.get("/api/team/dashboard").then((r) => r.json());

    for (const code of ["SL", "CB", "UD"]) {
      expect(dash.chipEligibility[code].eligible, `${code} must not be offerable`).toBe(false);
      expect(dash.chipEligibility[code].reason).toMatch(/not available yet/i);
    }
    await apiSignOut(request);
  });

  test("the PL fixture card carries the league's chips, not a fixed trio", async ({ request }) => {
    const { slug } = await createLeague(request, "b", ["SL", "CB", "UD"]);
    await apiSignInTeam(request, slug, 1);
    const body = await request.get("/api/team/dashboard/pl-fixture?gw=1").then((r) => r.json());

    if (body?.fixture) {
      for (const side of [body.fixture.home, body.fixture.away]) {
        expect([...side.tvtChips.enabled].sort()).toEqual(["CB", "SL", "UD"]);
      }
    }
    await apiSignOut(request);
  });
});
