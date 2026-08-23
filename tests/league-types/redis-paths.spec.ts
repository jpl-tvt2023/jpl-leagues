/**
 * The Redis-backed paths: caching, single-flight, and the scoring lock.
 *
 * These are invisible to the rest of the suite. `.env.test` ships blank Upstash
 * credentials on purpose, so every helper in fpl-cache.ts no-ops and none of
 * this code ever runs — which is exactly why it needs a spec of its own.
 * Provide a test Redis via `.env.test.local` (copy `.env.test.local.example`)
 * and these run; without one they skip and the suite behaves as before.
 *
 * Every assertion here is on the stub's request COUNTERS rather than on timing.
 * "The second load was fast" does not prove a cache was used; "the second load
 * made zero calls to entry/history" does.
 *
 * Run with: npm run test:e2e -- tests/league-types/redis-paths.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { Redis } from "@upstash/redis";
import {
  apiSignInSuperadmin,
  apiSignOut,
  createTvtLeague,
  generateFixtures,
  setupAllTeams,
  ensureGameweeks,
  expireGameweek,
  type LeagueRef,
} from "../harness";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);

/** Asserted against directly — the key name is part of the contract. */
const SCORING_LOCK_KEY = "fpl:scoring-active";

let league: LeagueRef;

async function counts(request: APIRequestContext): Promise<Record<string, number>> {
  const res = await request.get("/api/test-fpl-stub/control");
  expect(res.ok(), "stub /control should be reachable").toBeTruthy();
  return ((await res.json()).counts ?? {}) as Record<string, number>;
}

async function resetCounts(request: APIRequestContext): Promise<void> {
  await request.post("/api/test-fpl-stub/control", { data: { resetCounts: true } });
}

function leagueUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}leagueSlug=${encodeURIComponent(league.slug)}`;
}

test.describe.serial("Redis-backed paths (TVT)", () => {
  test.skip(
    !HAS_REDIS,
    "no test Redis configured — copy .env.test.local.example to .env.test.local",
  );

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    if (!HAS_REDIS) return;

    await apiSignInSuperadmin(request);
    league = await createTvtLeague(request, { teams: 8 });
    await setupAllTeams(request, league.slug, league.teamSize, "tvt");
    await apiSignInSuperadmin(request);
    await ensureGameweeks(league.id);
    await generateFixtures(request, league.slug);
    await request.post("/api/test-fpl-stub/control", {
      data: { finishedThrough: 3, liveGw: null },
    });
    for (const gw of [1, 2, 3]) await expireGameweek(league.id, gw);
    await apiSignOut(request);
  });

  test("the FPL League table converges, then serves later loads without touching FPL", async ({
    request,
  }) => {
    // Regression guard for the bug where `warming` could never reach zero.
    // Polls with warm=1 because a plain read deliberately fetches nothing.
    let latest: {
      warming: number;
      cacheEnabled: boolean;
      rows: { pending?: true }[];
    } | null = null;

    await expect
      .poll(
        async () => {
          const res = await request.get(leagueUrl("/api/fpl-league?warm=1"));
          expect(res.ok()).toBeTruthy();
          latest = await res.json();
          return latest!.warming;
        },
        {
          timeout: 90_000,
          intervals: [2000],
          message: "FPL League warming never reached zero",
        },
      )
      .toBe(0);

    expect(latest!.cacheEnabled, "a test Redis is configured, so this must be true").toBe(true);
    expect(latest!.rows.length).toBe(league.teamSize * 2);
    expect(
      latest!.rows.filter((r) => r.pending).length,
      "every manager should have data once warming is done",
    ).toBe(0);

    // Now the real point: a warm league costs nothing.
    await resetCounts(request);
    const res = await request.get(leagueUrl("/api/fpl-league"));
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.rows.length).toBe(league.teamSize * 2);

    const after = await counts(request);
    expect(after["entry/history"] ?? 0, "a fully cached league must make zero FPL calls").toBe(0);
  });

  test("concurrent refreshes coalesce into a single FPL sweep", async ({ request }) => {
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: 1 } });
    await expireGameweek(league.id, 1);
    await resetCounts(request);

    const url = leagueUrl("/api/fixtures/live/refresh?gameweek=1");
    // Fired together on purpose — the single-flight claim is released in a
    // `finally`, so sequential callers would each legitimately win.
    const responses = await Promise.all([request.get(url), request.get(url), request.get(url)]);
    const bodies = await Promise.all(responses.map((r) => r.json()));

    const winners = bodies.filter((b) => !b.stale);
    expect(winners.length, "exactly one caller should sweep; the rest serve cache").toBe(1);

    // computeLiveFixtureScores fetches the live element map once per sweep, so
    // this counter IS the number of sweeps.
    const after = await counts(request);
    expect(after["event/live"] ?? 0, "three concurrent refreshes must produce one sweep").toBe(1);
  });

  test("a scoring run blocks background FPL calls but still serves the page", async ({
    request,
  }) => {
    const redis = new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! });

    // Start from a genuinely cold cache. Two reasons, both of which produced a
    // false result before:
    //
    //   fpl:history / fpl-league:warm — a warm cache makes zero FPL calls
    //   whether or not the scoring lock works, so "zero calls" would prove
    //   nothing.
    //
    //   live:gw* / live:refresh:lock — the previous test leaves a populated
    //   live cache behind. The refresh route serves that cache with a 200
    //   whenever it loses the single-flight claim, returning before it ever
    //   reaches the gateway. This test would then sit in a 200 loop and never
    //   observe the refusal it is asserting on.
    for (const pattern of [
      "fpl:history:*",
      "fpl-league:warm:*",
      "live:gw*",
      "live:refresh:lock:*",
    ]) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }

    await redis.set(SCORING_LOCK_KEY, "1", { ex: 120 });
    try {
      // Wait out the gateway's scoring-lock cache before asking anything.
      //
      // fpl/gateway.ts caches the lookup for 5s so it does not add a Redis hop
      // to every outbound call. Polling immediately races that window: the
      // first sweep runs entirely on the stale `false`, completes normally,
      // and repopulates the live cache — so later polls lose the single-flight
      // claim and get a cached 200 instead of ever reaching the gateway. That
      // is what made this test pass only on retry.
      //
      // Sleeping past the documented TTL is the honest fix here; the delay is
      // a real property of the system, not test flakiness to be papered over.
      await new Promise((r) => setTimeout(r, 6000));

      await expect
        .poll(
          async () => {
            const res = await request.get(leagueUrl("/api/fixtures/live/refresh?gameweek=1"), {
              failOnStatusCode: false,
            });
            return res.status();
          },
          { timeout: 30_000, intervals: [1000], message: "refresh never saw the scoring lock" },
        )
        .toBe(503);

      // The FPL League page takes the same refusal, but must absorb it: a
      // scoring run is routine, and blanking a public page for two minutes
      // every time one starts would be worse than showing stale rows.
      await resetCounts(request);
      // warm=1, so this genuinely tries to fetch and is genuinely refused. A
      // plain read fetches nothing by design, which would make the zero-call
      // assertion below true for the wrong reason.
      const res = await request.get(leagueUrl("/api/fpl-league?warm=1"));
      expect(res.status(), "the page must degrade, not fail").toBe(200);

      const body = await res.json();
      expect(body.rows.length).toBe(league.teamSize * 2);
      expect(
        (await counts(request))["entry/history"] ?? 0,
        "scoring holds the lock, so no background entry fetch may happen",
      ).toBe(0);
    } finally {
      await redis.del(SCORING_LOCK_KEY);
    }

    // Prove the block was caused by the lock rather than something permanent:
    // once released, warming resumes.
    await resetCounts(request);
    await expect
      .poll(
        async () => {
          await request.get(leagueUrl("/api/fpl-league?warm=1"));
          return (await counts(request))["entry/history"] ?? 0;
        },
        { timeout: 30_000, intervals: [2000], message: "warming never resumed after the lock" },
      )
      .toBeGreaterThan(0);
  });

  test("a plain read serves the table instantly, fetching nothing", async ({ request }) => {
    // The property that keeps first paint instant. Warming a league is ~10s of
    // rate-capped FPL calls; if it ever moves back onto the read path the page
    // goes blank for that long instead of painting at once.
    //
    // The cold cache is the whole point of the test — with entries already warm
    // there is nothing to fetch and 'zero calls' would prove nothing.
    const redis = new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! });
    for (const pattern of ["fpl:history:*", "fpl-league:warm:*"]) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
    await resetCounts(request);

    const res = await request.get(leagueUrl("/api/fpl-league"));
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.rows.length, "the table still comes back in full").toBe(league.teamSize * 2);
    expect(body.warming, "and it knows rows are outstanding").toBeGreaterThan(0);
    expect(
      (await counts(request))["entry/history"] ?? 0,
      "a plain read must not fetch entry histories",
    ).toBe(0);
  });

  test("one warm pass fills the whole league, not a dozen at a time", async ({ request }) => {
    // Follows directly from the test above, which left the cache cold.
    await resetCounts(request);
    const res = await request.get(leagueUrl("/api/fpl-league?warm=1"));
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(
      body.warming,
      "a single warm request should finish the league, not leave rows for later",
    ).toBe(0);
    expect(body.rows.filter((r: { pending?: true }) => r.pending).length).toBe(0);
    expect(
      (await counts(request))["entry/history"] ?? 0,
      "it really did fetch them",
    ).toBe(league.teamSize * 2);
  });

  test("a lapsed live cache is served immediately rather than recomputed", async ({ request }) => {
    await request.post("/api/test-fpl-stub/control", { data: { finishedThrough: 0, liveGw: 1 } });
    await expireGameweek(league.id, 1);

    // Populate the live cache, then age it past the fresh window by rewriting
    // cachedAt — freshness is judged from the payload, not from key expiry.
    const redis = new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! });
    // Clear any refresh claim left by an earlier test. Without this the sweep
    // below loses the single-flight race, returns 202 pending, and never
    // populates the cache this test is about.
    const stale = await redis.keys("live:refresh:lock:*");
    if (stale.length > 0) await redis.del(...stale);

    const seeded = await request.get(leagueUrl("/api/fixtures/live/refresh?gameweek=1"));
    expect(seeded.ok(), "the seeding sweep should win the claim").toBeTruthy();
    const key = `live:gw1:${league.id}`;
    const stored = await redis.get<{ cachedAt: string; fixtures: unknown[] }>(key);
    expect(stored, "the refresh should have populated the live cache").toBeTruthy();
    await redis.set(
      key,
      { ...stored!, cachedAt: new Date(Date.now() - 30 * 60_000).toISOString() },
      { ex: 3600 },
    );

    await resetCounts(request);
    const res = await request.get(leagueUrl("/api/fixtures/live?gameweek=1"));
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    expect(body.stale, "30 minutes old is past the 10-minute fresh window").toBe(true);
    expect(body.fixtures.length, "but it is served, not withheld").toBeGreaterThan(0);

    // The point: nobody waits for a sweep. The client refreshes behind this.
    const after = await counts(request);
    expect(
      (after["entry/picks"] ?? 0) + (after["event/live"] ?? 0),
      "serving a stale copy must not touch FPL",
    ).toBe(0);
  });

  test.afterAll(async ({ request }) => {
    if (!HAS_REDIS) return;
    await request
      .post("/api/test-fpl-stub/control", {
        data: { finishedThrough: 0, liveGw: null, resetCounts: true },
      })
      .catch(() => {});
    // Never leave the lock set — it would refuse background FPL calls for the
    // next two minutes of whatever spec runs after this one.
    await new Redis({ url: REDIS_URL!, token: REDIS_TOKEN! }).del(SCORING_LOCK_KEY).catch(() => {});
  });
});
