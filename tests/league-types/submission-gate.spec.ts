/**
 * The submission gate: GW(n+1) captain/chip declarations stay shut until FPL
 * marks GW(n) finished.
 *
 * Why this exists: Double Pointer's rank rule and Challenge Chip's top-2
 * target are both league-table position dependent. Before this gate, the
 * portal accepted GW2 chip declarations while GW1 was still being played —
 * i.e. against a table that had not settled.
 *
 * The pure branch coverage lives in tests/unit/gameweek-window.test.ts; this
 * spec pins the end-to-end behaviour through the real routes, driving FPL
 * state via the stub's /control endpoint.
 *
 * Run with: npm run test:e2e -- tests/league-types/submission-gate.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  apiSignInSuperadmin,
  apiSignInTeam,
  apiSignOut,
  createTvtLeague,
  generateFixtures,
  setupAllTeams,
  ensureGameweeks,
  testDb,
  schema,
  type LeagueRef,
} from "../harness";
import { and, eq } from "drizzle-orm";

let league: LeagueRef;

async function setStub(
  request: APIRequestContext,
  body: { finishedThrough?: number; liveGw?: number | null },
) {
  const res = await request.post("/api/test-fpl-stub/control", { data: body });
  expect(res.ok(), "FPL stub control endpoint should be reachable").toBeTruthy();
}

/** Read the dashboard's submission block for the signed-in team. */
async function submissionState(request: APIRequestContext) {
  const res = await request.get("/api/team/dashboard");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.submission as {
    gameweek: number;
    state: string;
    awaitingGw: number | null;
    degraded: boolean;
  };
}

test.describe.serial("submission gate (TVT)", () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    await setupAllTeams(request, league.slug, league.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(league.id);
    await generateFixtures(request, league.slug);
    await apiSignOut(request);
  });

  test("GW1 is open even though nothing has finished — nothing precedes it", async ({ request }) => {
    await setStub(request, { finishedThrough: 0, liveGw: null });
    await apiSignInTeam(request, league.slug, 1);

    const submission = await submissionState(request);
    expect(submission.gameweek).toBe(1);
    expect(submission.state).toBe("open");
    expect(submission.awaitingGw).toBeNull();
    await apiSignOut(request);
  });

  test("while GW1 is in flight, GW2 is gated on FPL finishing GW1", async ({ request }) => {
    // GW1 live ⇒ its deadline is in the past, so the window advances to GW2 —
    // but GW1 is not finished, so GW2 must not open.
    await setStub(request, { finishedThrough: 0, liveGw: 1 });
    await apiSignInTeam(request, league.slug, 1);

    const submission = await submissionState(request);
    expect(submission.gameweek).toBe(2);
    // Check `degraded` first: if FPL status could not be read the gate falls
    // open by design, and asserting on `state` alone would report that as a
    // gate failure rather than the fetch failure it actually is.
    expect(submission.degraded, "FPL status was unavailable, so the gate fell open").toBe(false);
    expect(submission.state).toBe("awaiting-results");
    expect(submission.awaitingGw).toBe(1);
    await apiSignOut(request);
  });

  test("captain and chip submissions are rejected server-side while gated", async ({ request }) => {
    await setStub(request, { finishedThrough: 0, liveGw: 1 });
    await apiSignInTeam(request, league.slug, 1);

    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    const playerId = dash?.captaincyStatus?.player1?.id as string;
    expect(playerId, "expected a player id from captaincyStatus").toBeTruthy();

    const captain = await request.post("/api/team/captain", {
      data: { playerId, gameweek: 2 },
      failOnStatusCode: false,
    });
    expect(captain.status()).toBe(400);
    expect(await captain.text()).toContain("GW1");

    const chip = await request.post("/api/team/chips", {
      data: { gameweek: 2, chipType: "W" },
      failOnStatusCode: false,
    });
    expect(chip.status()).toBe(400);

    await apiSignOut(request);
  });

  test("chip eligibility is suppressed rather than computed off a moving table", async ({ request }) => {
    await setStub(request, { finishedThrough: 0, liveGw: 1 });
    await apiSignInTeam(request, league.slug, 1);

    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    for (const code of ["D", "C", "W"]) {
      expect(dash.chipEligibility[code].eligible, `${code} should be ineligible`).toBe(false);
      expect(dash.chipEligibility[code].reason).toContain("GW1");
    }
    await apiSignOut(request);
  });

  test("once FPL marks GW1 finished, GW2 opens and accepts a submission", async ({ request }) => {
    await setStub(request, { finishedThrough: 1, liveGw: null });
    await apiSignInTeam(request, league.slug, 1);

    const submission = await submissionState(request);
    expect(submission.gameweek).toBe(2);
    expect(submission.state).toBe("open");

    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    const playerId = dash?.captaincyStatus?.player1?.id as string;
    const res = await request.post("/api/team/captain", {
      data: { playerId, gameweek: 2 },
      failOnStatusCode: false,
    });
    expect(res.ok(), `captain POST failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    await apiSignOut(request);
  });

  test("a rejected submission is recorded as a LATE_ATTEMPT audit row", async ({ request }) => {
    await setStub(request, { finishedThrough: 0, liveGw: 1 });
    await apiSignInTeam(request, league.slug, 2);

    const dash = await request.get("/api/team/dashboard").then((r) => r.json());
    const playerId = dash?.captaincyStatus?.player1?.id as string;
    await request.post("/api/team/captain", {
      data: { playerId, gameweek: 2 },
      failOnStatusCode: false,
    });

    // Scope the assertion to this league's GW2 rather than to a team row —
    // the gameweek id is unambiguous and does not depend on how login ids are
    // derived.
    const db = testDb();
    const gw2 = await db
      .select({ id: schema.gameweeks.id })
      .from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, league.id), eq(schema.gameweeks.number, 2)))
      .limit(1);
    expect(gw2.length).toBe(1);

    const rows = await db
      .select({ id: schema.auditLogs.id })
      .from(schema.auditLogs)
      .where(
        and(
          eq(schema.auditLogs.type, "LATE_ATTEMPT"),
          eq(schema.auditLogs.gameweekId, gw2[0].id),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    await apiSignOut(request);
  });

  test.afterAll(async ({ request }) => {
    await setStub(request, { finishedThrough: 0, liveGw: null }).catch(() => {});
  });
});
