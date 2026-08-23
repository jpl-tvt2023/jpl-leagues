/**
 * Read-only smoke test against a deployed environment (normally staging).
 *
 *   SMOKE_BASE_URL=https://<preview>.vercel.app npm run smoke:staging
 *
 * Optional:
 *   SMOKE_LEAGUE_SLUG=<slug>   test this league instead of auto-picking one
 *   SMOKE_BYPASS_TOKEN=<tok>   Vercel Deployment Protection bypass secret
 *
 * Scope, deliberately narrow: plain HTTP against public endpoints, no browser,
 * no stub, and **no writes to participant data**. Staging holds a copy of real
 * league data, so this only ever issues GETs. (The refresh endpoint is a GET
 * that populates a Redis cache — no database rows are touched.)
 *
 * What it is actually for: catching the failures that only appear on real data
 * and real infrastructure. A 64-manager league is 64 FPL round trips, and the
 * Vercel Hobby plan hard-kills any function at 60 seconds — a sweep that takes
 * 55s passes every local test and then fails in production the week the league
 * grows. So timings are reported, not just pass/fail, and a sweep creeping
 * toward the ceiling is called out while it is still passing.
 */

const BASE_URL = (process.env.SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
const BYPASS = process.env.SMOKE_BYPASS_TOKEN;
const FORCED_SLUG = process.env.SMOKE_LEAGUE_SLUG;

/** Vercel's own ceiling. Anything close to it is a latent outage. */
const HOBBY_LIMIT_MS = 60_000;
/** Report a sweep above this as "no headroom" even though it passed. */
const HEADROOM_WARN_MS = 40_000;

if (!BASE_URL) {
  console.error(
    "SMOKE_BASE_URL is required.\n" +
      "  e.g. SMOKE_BASE_URL=https://jpl-leagues-git-xxx.vercel.app npm run smoke:staging",
  );
  process.exit(2);
}

interface Result {
  name: string;
  status: "pass" | "fail" | "skip" | "warn";
  ms: number;
  detail: string;
}

const results: Result[] = [];
let hardFailures = 0;

function record(name: string, status: Result["status"], ms: number, detail: string) {
  results.push({ name, status, ms, detail });
  if (status === "fail") hardFailures++;
  const icon = { pass: "✓", fail: "✗", skip: "·", warn: "!" }[status];
  console.log(`  ${icon} ${name} (${ms}ms) — ${detail}`);
}

async function get(path: string): Promise<{ res: Response; ms: number; body: unknown }> {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {},
    redirect: "manual",
  });
  const ms = Date.now() - started;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON is itself a finding — most often Vercel's SSO interstitial.
  }
  return { res, ms, body };
}

/** A check that either passes or records a hard failure, never throws. */
async function check(name: string, fn: () => Promise<[boolean, string, number]>) {
  try {
    const [ok, detail, ms] = await fn();
    record(name, ok ? "pass" : "fail", ms, detail);
  } catch (err) {
    record(name, "fail", 0, `threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface League {
  slug: string;
  name: string;
  format: string;
  teamSize: number;
}

interface FplLeaguePayload {
  warming: number;
  cacheEnabled: boolean;
  rows: unknown[];
  gw: number | null;
  isLive: boolean;
}

async function main() {
  console.log(`\n🔍  Smoke test against ${BASE_URL}\n`);

  // ── Reachability, and the protection wall ───────────────────────────────
  const leaguesCall = await get("/api/leagues");
  if (!leaguesCall.res.ok || !leaguesCall.body) {
    const hint =
      leaguesCall.res.status === 401 || leaguesCall.res.status === 403
        ? " — this is almost certainly Vercel Deployment Protection; pass SMOKE_BYPASS_TOKEN or disable it for Preview"
        : "";
    record("GET /api/leagues", "fail", leaguesCall.ms, `HTTP ${leaguesCall.res.status}${hint}`);
    return finish();
  }

  const leagues = (leaguesCall.body as { leagues?: League[] }).leagues ?? [];
  record("GET /api/leagues", "pass", leaguesCall.ms, `${leagues.length} active league(s)`);
  if (leagues.length === 0) {
    record("pick a league", "fail", 0, "no active leagues to test against");
    return finish();
  }

  const requested = FORCED_SLUG ? leagues.find((l) => l.slug === FORCED_SLUG) : undefined;
  const league = requested ?? leagues.find((l) => l.format === "tvt") ?? leagues[0];
  if (FORCED_SLUG && league.slug !== FORCED_SLUG) {
    record("pick a league", "warn", 0, `SMOKE_LEAGUE_SLUG=${FORCED_SLUG} not found; using ${league.slug}`);
  }
  console.log(`\n  Testing league: ${league.name} (${league.slug}, ${league.format})\n`);

  const q = `leagueSlug=${encodeURIComponent(league.slug)}`;

  // ── Public read endpoints return the right shapes ───────────────────────
  await check("GET /api/standings", async () => {
    const { res, ms, body } = await get(`/api/standings?${q}`);
    if (!res.ok) return [false, `HTTP ${res.status}`, ms];
    const b = body as { standings?: unknown[]; teams?: unknown[] };
    const rows = b.standings ?? b.teams;
    return [Array.isArray(rows), Array.isArray(rows) ? `${rows.length} rows` : "no rows array in payload", ms];
  });

  await check("GET /api/fixtures", async () => {
    const { res, ms } = await get(`/api/fixtures?${q}`);
    return [res.ok, `HTTP ${res.status}`, ms];
  });

  // ── The FPL League page: does it converge on a real-sized league? ────────
  // This is the one that scales badly. It warms a bounded batch per request, so
  // a cold 64-manager league needs several rounds; if it never settles, the page
  // polls forever and the outbound FPL calls never stop.
  let gw: number | null = null;
  let isLive = false;

  await check("GET /api/fpl-league converges", async () => {
    const started = Date.now();
    let rounds = 0;
    let last: FplLeaguePayload | null = null;

    while (Date.now() - started < 120_000) {
      const { res, body } = await get(`/api/fpl-league?${q}`);
      rounds++;
      if (!res.ok) return [false, `HTTP ${res.status}`, Date.now() - started];
      last = body as FplLeaguePayload | null;
      if (!last) return [false, "empty payload", Date.now() - started];
      if (last.warming === 0) break;
      await new Promise((r) => setTimeout(r, 4000));
    }

    const ms = Date.now() - started;
    if (!last) return [false, "no response", ms];
    gw = last.gw;
    isLive = last.isLive;

    if (!last.cacheEnabled) {
      return [false, "cacheEnabled=false — Upstash is not configured on this deployment", ms];
    }
    if (last.warming !== 0) {
      return [false, `still warming ${last.warming} after ${rounds} rounds`, ms];
    }
    return [true, `${last.rows.length} managers, settled in ${rounds} round(s), GW${last.gw}`, ms];
  });

  // ── The expensive path, and its headroom under the 60s ceiling ───────────
  if (gw == null) {
    record("refresh sweep", "skip", 0, "no gameweek resolved — nothing to sweep");
  } else if (!isLive) {
    // Refreshing a settled gameweek costs a full sweep to return numbers that
    // cannot change, and the UI disables the button for exactly that reason.
    record(
      "refresh sweep",
      "skip",
      0,
      `GW${gw} is not live — re-run during a live gameweek to time a real sweep`,
    );
  } else {
    await check("refresh sweep completes under the Hobby ceiling", async () => {
      const { res, ms, body } = await get(`/api/fixtures/live/refresh?gameweek=${gw}&${q}`);
      if (!res.ok && res.status !== 202) return [false, `HTTP ${res.status}`, ms];
      const fixtures = (body as { fixtures?: unknown[] }).fixtures?.length ?? 0;
      if (ms >= HOBBY_LIMIT_MS) return [false, `${(ms / 1000).toFixed(1)}s — at or past the 60s limit`, ms];
      const headroom = ((HOBBY_LIMIT_MS - ms) / 1000).toFixed(1);
      if (ms >= HEADROOM_WARN_MS) {
        record("refresh headroom", "warn", ms, `only ${headroom}s of headroom left before Vercel kills it`);
      }
      return [true, `${fixtures} fixtures, ${headroom}s headroom`, ms];
    });

    await check("concurrent refreshes coalesce", async () => {
      const started = Date.now();
      const url = `/api/fixtures/live/refresh?gameweek=${gw}&${q}`;
      const bodies = await Promise.all([get(url), get(url), get(url)]);
      const ms = Date.now() - started;
      const sweeps = bodies.filter((b) => !(b.body as { stale?: boolean })?.stale).length;
      // One sweeps, the others serve cache flagged stale. More than one means
      // the single-flight claim is not working and N clicks cost N sweeps.
      return [sweeps === 1, `${sweeps} of 3 callers swept (want exactly 1)`, ms];
    });
  }

  finish();
}

function finish() {
  const pass = results.filter((r) => r.status === "pass").length;
  const warn = results.filter((r) => r.status === "warn").length;
  const skip = results.filter((r) => r.status === "skip").length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${pass} passed, ${hardFailures} failed, ${warn} warning(s), ${skip} skipped`);

  const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3).filter((r) => r.ms > 0);
  if (slowest.length > 0) {
    console.log("\n  Slowest:");
    for (const r of slowest) console.log(`    ${(r.ms / 1000).toFixed(1)}s  ${r.name}`);
  }
  console.log("");

  process.exit(hardFailures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n❌  smoke-staging crashed:\n", err);
  process.exit(1);
});
