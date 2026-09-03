/**
 * A TVT chip is WASTED when either of the team's managers played an FPL chip that gameweek.
 *
 * The rule was written down nowhere and enforced nowhere before this: a team could burn a
 * Wildcard and a Double Pointer in the same week and keep both. These tests pin the scorer half —
 * the half that moves league points.
 *
 * The sharpest thing here is the REPROCESS case. Waste is recorded in `wasted_reason`, never by
 * flipping `is_valid` to false, because the force-reprocess reset clears the former and not the
 * latter. Marking waste the wrong way would exclude the chip from the scorer's own
 * `isValid: true` query on every subsequent re-score — silently, and forever.
 *
 * Run with: npm run test:e2e -- tests/league-types/fpl-chip-waste.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
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
let chipTeamId: string;
let chipTeamName: string;
let chipTeamFplIds: string[];

/** Replace the stub's chip history. Also sweeps fpl:history:*, so the scorer refetches. */
async function setFplChips(
  request: APIRequestContext,
  overrides: Record<string, { name: string; event: number }[]>,
) {
  const res = await request.post("/api/test-fpl-stub/control", { data: { chipOverrides: overrides } });
  expect(res.ok(), await res.text()).toBe(true);
}

async function scoreGw(request: APIRequestContext, force = false) {
  await apiSignInSuperadmin(request);
  const res = await request.post(
    `/api/gameweeks/${GW}?leagueId=${leagueId}${force ? "&force=true" : ""}`,
    { failOnStatusCode: false },
  );
  expect(res.status(), await res.text()).toBe(200);
}

async function chipRow() {
  const db = testDb();
  const [row] = await db
    .select()
    .from(schema.gameweekChips)
    .where(and(eq(schema.gameweekChips.teamId, chipTeamId), eq(schema.gameweekChips.chipType, "D")))
    .limit(1);
  expect(row, "the Double Pointer chip row should exist").toBeTruthy();
  return row;
}

test.describe.serial("TVT chip wasted by an FPL chip", () => {
  test.beforeAll(async ({ request }) => {
    await apiSignInSuperadmin(request);
    slug = "fcw-" + Date.now().toString(36);
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "FPL Chip Waste", sport: "fpl", format: "tvt",
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
    chipTeamId = teamRows[0].id;
    chipTeamName = teamRows[0].name;

    const playerRows = await db.select().from(schema.players).where(eq(schema.players.teamId, chipTeamId));
    expect(playerRows.length, "a TVT team has two managers").toBeGreaterThan(1);
    chipTeamFplIds = playerRows.map((p) => p.fplId);

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
  });

  test.afterAll(async ({ request }) => {
    // Stub state is process-wide; hand it back as we found it.
    await request.post("/api/test-fpl-stub/control", { data: { chipOverrides: {} } });
  });

  test("no FPL chip: the TVT chip scores normally", async ({ request }) => {
    // Explicit empty arrays, not "no override" — the stub's default plan is hash-gated and could
    // hand one of these managers a chip by luck, which would test the opposite of the intent.
    await setFplChips(request, Object.fromEntries(chipTeamFplIds.map((id) => [id, []])));
    await scoreGw(request);

    const chip = await chipRow();
    expect(chip.isProcessed, `${chipTeamName}'s chip should be processed`).toBe(true);
    expect(chip.wastedReason, "no FPL chip means no waste").toBeNull();
  });

  test("one manager's FPL chip wastes the team's TVT chip", async ({ request }) => {
    // Only the FIRST manager plays one. The rule is team-wide, so this is enough.
    await setFplChips(request, {
      [chipTeamFplIds[0]]: [{ name: "bboost", event: GW }],
      [chipTeamFplIds[1]]: [],
    });
    await scoreGw(request, true);

    const chip = await chipRow();
    expect(chip.isProcessed).toBe(true);
    expect(chip.wastedReason, "the chip should be wasted").toBeTruthy();
    expect(chip.wastedReason).toContain("Bench Boost");
    expect(chip.wastedReason).toContain("Double Pointer");
    // pointsAwarded stores the EXTRA points a chip contributed. A wasted chip contributes none.
    expect(chip.pointsAwarded, "a wasted chip awards nothing").toBe(0);
  });

  test("waste survives a reprocess unchanged — and is not recorded as isValid:false", async ({ request }) => {
    // The regression this file exists for. `isValid` must still be true: the DECLARATION was
    // valid, the chip was merely wasted. Had waste been stored as isValid:false, the scorer's
    // own `isValid: true` chip query would skip this row on every future re-score.
    const before = await chipRow();
    expect(before.isValid, "a wasted chip is still a valid declaration").toBe(true);

    await scoreGw(request, true);

    const after = await chipRow();
    expect(after.wastedReason, "still wasted after a reprocess").toBe(before.wastedReason);
    expect(after.pointsAwarded).toBe(0);
    expect(after.isValid).toBe(true);
    expect(after.isProcessed).toBe(true);
  });

  test("removing the FPL chip un-wastes it on the next reprocess", async ({ request }) => {
    // Proves the force-reset clears wasted_reason. Without that clear, a chip wasted once would
    // stay wasted for the rest of the season no matter what the data said.
    await setFplChips(request, Object.fromEntries(chipTeamFplIds.map((id) => [id, []])));
    await scoreGw(request, true);

    const chip = await chipRow();
    expect(chip.wastedReason, "no clash any more, so no waste").toBeNull();
    expect(chip.isProcessed).toBe(true);
  });

  test("an FPL chip in a DIFFERENT gameweek does not waste it", async ({ request }) => {
    await setFplChips(request, {
      [chipTeamFplIds[0]]: [{ name: "3xc", event: GW + 1 }],
      [chipTeamFplIds[1]]: [],
    });
    await scoreGw(request, true);

    const chip = await chipRow();
    expect(chip.wastedReason, "the clash is per gameweek").toBeNull();
  });
});
