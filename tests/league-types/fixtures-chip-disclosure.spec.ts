/**
 * A chip must become public the moment its gameweek's deadline passes.
 *
 * /api/fixtures gates chip disclosure on `deadline > now` — correctly, since a gameweek_chips
 * row exists from the moment a chip is DECLARED and this payload is public to the whole league.
 * But the finished payload was then cached for 25 hours under a flat key, freezing that verdict:
 * a gameweek's chips stayed invisible for the full TTL after it went live, because nothing
 * invalidates when a deadline passes. A deadline is not a write, and there is no cron.
 *
 * This lives in its own file rather than in redis-paths.spec.ts on purpose: that spec is
 * describe.serial and currently dies on an unrelated failure ("concurrent refreshes coalesce"),
 * which would skip this and hide a real regression.
 *
 * Needs a test Redis — with none, every cache helper no-ops and the bug cannot reproduce, which
 * is exactly why the suite never caught it. Copy .env.test.local.example to .env.test.local.
 *
 * Run with: npm run test:e2e -- tests/league-types/fixtures-chip-disclosure.spec.ts
 */

import { test, expect } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  apiSignInSuperadmin, apiSignOut, setupAllTeams, ensureGameweeks, generateFixtures,
  expireGameweek, invalidateLeagueCache, testDb, schema,
} from "../harness";

const HAS_REDIS = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);

const TEAMS = 8;
/** Far enough out that its deadline is still ahead while the spec runs. */
const FUTURE_GW = 6;

let leagueId: string;
let slug: string;
let teamId: string;

test.describe.serial("fixtures chip disclosure survives the cache", () => {
  test.skip(
    !HAS_REDIS,
    "no test Redis configured — the cache no-ops, so this bug cannot reproduce",
  );

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    if (!HAS_REDIS) return;

    await apiSignInSuperadmin(request);
    slug = `fcd-${Date.now().toString(36).slice(-5)}`;
    const res = await request.post("/api/superadmin/leagues", {
      data: {
        slug, name: "Fixtures Chip Disclosure", sport: "fpl", format: "tvt",
        season: "2025-26", teamSize: TEAMS, groupCount: 2, enabledChips: ["D", "W", "C"],
      },
      failOnStatusCode: false,
    });
    expect(res.status(), await res.text()).toBe(200);
    leagueId = (await res.json()).id;

    await setupAllTeams(request, slug, TEAMS, "tvt");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(leagueId);
    await generateFixtures(request, slug);
    await apiSignOut(request);

    const db = testDb();
    const [gw] = await db.select().from(schema.gameweeks)
      .where(and(eq(schema.gameweeks.leagueId, leagueId), eq(schema.gameweeks.number, FUTURE_GW))).limit(1);
    expect(gw, `GW${FUTURE_GW} should exist`).toBeTruthy();
    expect(gw.deadline.getTime(), "the planted gameweek must still be ahead")
      .toBeGreaterThan(Date.now());

    const [team] = await db.select().from(schema.teams)
      .where(eq(schema.teams.leagueId, leagueId)).limit(1);
    teamId = team.id;

    await db.insert(schema.gameweekChips).values({
      id: randomUUID(), gameweekId: gw.id, teamId,
      chipType: "W", isValid: true, isProcessed: false,
    });
    // Writing rows directly bypasses the handlers that normally invalidate.
    await invalidateLeagueCache(leagueId);
  });

  test("a chip declared for a future gameweek is not published", async ({ request }) => {
    // This call also WARMS the cache, which is what the second test needs.
    const body = await request.get(`/api/fixtures?leagueSlug=${slug}`).then((r) => r.json());
    expect(body.chipsByGameweek?.[FUTURE_GW]?.[teamId], "a pending chip must stay hidden")
      .toBeUndefined();
  });

  test("it IS published once the deadline passes, against that warm cache", async ({ request }) => {
    await expireGameweek(leagueId, FUTURE_GW);
    // Deliberately NO invalidation. Nothing invalidates when a deadline passes in production
    // either — that is the entire bug.
    const body = await request.get(`/api/fixtures?leagueSlug=${slug}`).then((r) => r.json());
    const entry = body.chipsByGameweek?.[FUTURE_GW]?.[teamId];
    expect(entry, "once the deadline passes the chip must be published").toBeTruthy();
    expect(entry.chipType).toBe("W");
  });
});
