import { NextRequest, NextResponse } from "next/server";

/**
 * Deterministic stand-in for the Fantasy Premier League API, used by the
 * Playwright suite.
 *
 * Why this exists: every helper in fpl-cache.ts no-ops when Redis is absent,
 * and .env.test deliberately ships blank Upstash credentials. So in tests
 * there is no cache at all and every FPL call would go straight to the real,
 * undocumented, Cloudflare-fronted API. One run of the FPL League page would
 * be 64 live requests. Point FPL_BASE_URL at this route instead and the suite
 * never touches the internet.
 *
 * Data is generated from the entry/element id rather than recorded, so there
 * are no fixture files to keep in sync and every value is reproducible.
 *
 * Note the route name has no leading underscore. Next.js treats a folder
 * prefixed with `_` as a private folder and excludes it from the route tree
 * entirely, so an earlier `__test-fpl__` name silently 404'd every request.
 *
 * Test control: POST /api/test-fpl-stub/control { finishedThrough, liveGw }
 * mutates in-process state, which is how a spec drives the "GW finished"
 * gate in resolveSubmissionWindow. Playwright runs a single server, so
 * module-level state is shared with the routes under test.
 */

export const dynamic = "force-dynamic";

/** Hard gate — this route must never exist outside a test run. */
function isEnabled(): boolean {
  return process.env.NODE_ENV === "test" || process.env.TEST_FPL_STUB === "1";
}

interface StubState {
  /** Every GW <= this reports finished: true in bootstrap-static and /fixtures/. */
  finishedThrough: number;
  /**
   * Every GW <= this reports bonus_added: true in /event-status/.
   *
   * Separate from `finishedThrough` because the two genuinely diverge in
   * production: matches end, then FPL confirms bonus a while later. Scoring
   * gates on this one, team submission gates on `finishedThrough`. Defaults to
   * tracking `finishedThrough` when a spec never sets it explicitly.
   */
  bonusAddedThrough: number | null;
  /** The GW whose fixtures are mid-flight (kickoffs in the past, not finished). */
  liveGw: number | null;
  /**
   * Requests served, bucketed by route shape. Lets a spec assert on how many
   * FPL calls a page actually made -- the only honest way to test caching and
   * single-flight, which are otherwise indistinguishable from a fast response.
   */
  counts: Record<string, number>;
  /**
   * Force an entry's FPL chip history, keyed by FPL entry id.
   *
   * The default chip plan is hash-gated per entry, which is fine for populating a chips column
   * with a realistic mix but useless for a spec that needs "THIS manager played Bench Boost in
   * GW2". An override replaces that entry's chips outright, empty array included — which is how
   * a spec asserts the no-clash path.
   */
  chipOverrides: Record<string, { name: string; event: number }[]>;
  /**
   * Simulated FPL classic mini-leagues, keyed by FPL league id (as a string — control bodies are
   * JSON, and object keys are always strings there regardless of what they represent).
   *
   * Defaulted to one 120-entrant league so pagination (50 rows/page) is exercised without a spec
   * having to set anything up. Entry ids are in the 700000s specifically to stay clear of the
   * fplBase=1000 default every TVT spec uses — a classic-league test creating its OWN league
   * must never coincide with a TVT team's fplId, or Redis history cached by one bleeds into the
   * other exactly the way it did before Part 4's fplBase fix in fpl-chips-fixtures.spec.ts.
   */
  classicLeagues: Record<string, { name: string; startEvent: number; entryIds: number[] }>;
}

/**
 * Held on globalThis, not in a module-level `const`.
 *
 * Next's dev server re-evaluates route modules on hot reload, which silently
 * reset the state mid-spec: a suite that had set finishedThrough=3 would find
 * it back at 0 a few requests later, and assertions about live/finished
 * gameweeks would flake. globalThis survives module re-evaluation within the
 * same process.
 */
const DEFAULT_CLASSIC_LEAGUE_ID = "900001";
const DEFAULT_CLASSIC_ENTRY_COUNT = 120;
const DEFAULT_CLASSIC_ENTRY_BASE = 700_001;

function defaultClassicLeagues(): StubState["classicLeagues"] {
  return {
    [DEFAULT_CLASSIC_LEAGUE_ID]: {
      name: "Stub Classic",
      startEvent: 1,
      entryIds: Array.from({ length: DEFAULT_CLASSIC_ENTRY_COUNT }, (_, i) => DEFAULT_CLASSIC_ENTRY_BASE + i),
    },
  };
}

const globalForStub = globalThis as typeof globalThis & { __fplStubState?: StubState };
const state: StubState = (globalForStub.__fplStubState ??= {
  finishedThrough: 0,
  bonusAddedThrough: null,
  liveGw: null,
  counts: {},
  chipOverrides: {},
  classicLeagues: defaultClassicLeagues(),
});
// A server that was already running before counts existed keeps its old
// globalThis object, so the field can be genuinely absent here.
state.counts ??= {};
// Same reason as `counts`: a server started before this field existed keeps its
// old globalThis object, where the property is genuinely absent.
state.bonusAddedThrough ??= null;
// Same reason again, for a server already running before classic leagues existed.
state.classicLeagues ??= defaultClassicLeagues();

const TOTAL_ELEMENTS = 700;
const PL_TEAM_COUNT = 20;

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Deadlines, derived from the stub's own live/finished state.
 *
 * This matters more than it looks: /api/team/dashboard re-syncs every
 * gameweek deadline from bootstrap `deadline_time` on every request. So the
 * stub's dates are authoritative — fixed calendar dates would drift into the
 * past and silently retire GW1, breaking every spec that submits for a
 * future-deadline gameweek.
 *
 * They also have to be *coherent* with `finishedThrough` / `liveGw`: a
 * gameweek FPL reports as finished or in-flight must have a deadline in the
 * past, or the app sees a contradiction (a "live" GW nobody can have played).
 * So the newest such gameweek sits one day back, and everything after it is a
 * week apart into the future.
 *
 * Default state (nothing finished, nothing live) puts GW1 six days out, which
 * keeps it comfortably open for submission specs and well clear of the
 * 24h FORCE_OPEN_WITHIN_MS safety valve in gameweek-window.ts.
 */
function stubDeadline(gw: number): Date {
  const anchor = Math.max(state.finishedThrough, state.liveGw ?? 0);
  return new Date(Date.now() + (gw - anchor) * WEEK_MS - DAY_MS);
}

/** Stable pseudo-random in [0, n) derived from a seed — no Math.random. */
function hashed(seed: number, n: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return Math.abs(x ^ (x >>> 16)) % n;
}

function elementPoints(elementId: number, gw: number): number {
  return hashed(elementId * 97 + gw * 31, 13);
}

function entryGwPoints(entryId: number, gw: number): number {
  return 30 + hashed(entryId * 13 + gw * 7, 60);
}

function entryTransferCost(entryId: number, gw: number): number {
  return hashed(entryId * 5 + gw * 3, 10) === 0 ? 4 : 0;
}

/**
 * Running total through `throughGw`, gross (not net of transfer cost) — computed with the exact
 * same formula entryHistory's inline loop uses for `total_points` at that gameweek. Used by the
 * classic-league standings generator so the two endpoints can never numerically disagree; that
 * agreement is what lets an FPL Classic e2e spec assert the live standings figure equals what
 * settling later writes to fpl_classic_entry_gws.
 */
function cumulativePoints(entryId: number, throughGw: number): number {
  let running = 0;
  for (let gw = 1; gw <= throughGw; gw++) running += entryGwPoints(entryId, gw);
  return running;
}

function bootstrap() {
  return {
    events: Array.from({ length: 38 }, (_, i) => {
      const id = i + 1;
      return {
        id,
        name: `Gameweek ${id}`,
        deadline_time: stubDeadline(id).toISOString(),
        finished: id <= state.finishedThrough,
        data_checked: id <= state.finishedThrough,
        is_current: id === state.liveGw,
        is_next: state.liveGw != null && id === state.liveGw + 1,
      };
    }),
    teams: Array.from({ length: PL_TEAM_COUNT }, (_, i) => ({
      id: i + 1,
      name: `PL Team ${i + 1}`,
      short_name: `T${i + 1}`,
    })),
    elements: Array.from({ length: TOTAL_ELEMENTS }, (_, i) => {
      const id = i + 1;
      return {
        id,
        web_name: `Player ${id}`,
        team: (id % PL_TEAM_COUNT) + 1,
        element_type: (id % 4) + 1,
        now_cost: 40 + hashed(id, 90),
        total_points: hashed(id * 3, 200),
        status: "a",
        minutes: hashed(id * 11, 3000),
      };
    }),
  };
}

function entryHistory(entryId: number) {
  const throughGw = Math.max(state.finishedThrough, state.liveGw ?? 0);
  let running = 0;
  const current = [];
  for (let gw = 1; gw <= throughGw; gw++) {
    const points = entryGwPoints(entryId, gw);
    running += points;
    current.push({
      event: gw,
      points,
      total_points: running,
      rank: 1 + hashed(entryId + gw, 500_000),
      overall_rank: 1 + hashed(entryId * 2 + gw, 500_000),
      event_transfers: hashed(entryId + gw * 2, 3),
      event_transfers_cost: entryTransferCost(entryId, gw),
      points_on_bench: hashed(entryId * 7 + gw, 15),
      value: 1000,
      bank: 5,
    });
  }

  // Give roughly half the entries some chip history so the chips column has
  // both used and available states to render.
  const chips: { name: string; time: string; event: number }[] = [];
  const chipPlan: [string, number][] = [
    ["wildcard", 3],
    ["bboost", 5],
    ["3xc", 7],
    ["freehit", 9],
    ["wildcard", 22],
    ["manager", 11],
  ];
  const override = state.chipOverrides?.[String(entryId)];
  if (override) {
    // Outright replacement, not a merge — a spec asserting "no FPL chip" needs the default plan
    // gone, and an empty array must mean empty.
    for (const c of override) {
      chips.push({ name: c.name, time: new Date(Date.UTC(2026, 7, 14 + c.event * 7)).toISOString(), event: c.event });
    }
  } else {
    for (const [name, gw] of chipPlan) {
      if (gw <= throughGw && hashed(entryId + gw * 17, 2) === 0) {
        chips.push({ name, time: new Date(Date.UTC(2026, 7, 14 + gw * 7)).toISOString(), event: gw });
      }
    }
  }

  return { current, past: [], chips };
}

/**
 * `leagues-classic/{id}/standings/` — paginated 50 rows at a time, matching the real endpoint,
 * so the FPL Classic fetcher's pagination loop is genuinely exercised rather than short-circuited
 * by a single-page stub.
 *
 * `entry_name`/`player_name` match the shape the plain `entry/{id}` handler already returns for
 * the same id, and `total`/`event_total` are derived from `cumulativePoints`/`entryGwPoints` —
 * the SAME generators `entryHistory` uses — so a spec can settle a gameweek and assert the
 * persisted row equals what this endpoint reported while it was still live.
 */
const CLASSIC_PAGE_SIZE = 50;

function classicLeagueStandings(
  fplLeagueId: number,
  pageStandings: number,
  pageNewEntries: number,
): { status: number; body: unknown } {
  const league = state.classicLeagues[String(fplLeagueId)];
  if (!league) return { status: 404, body: { detail: "not found" } };

  const throughGw = Math.max(state.finishedThrough, state.liveGw ?? 0);
  const entryIds = league.entryIds;

  const start = (pageStandings - 1) * CLASSIC_PAGE_SIZE;
  const pageIds = entryIds.slice(start, start + CLASSIC_PAGE_SIZE);
  const hasNextStandings = start + CLASSIC_PAGE_SIZE < entryIds.length;

  const results = pageIds.map((entryId, i) => {
    const total = cumulativePoints(entryId, throughGw);
    const eventTotal = throughGw > 0 ? entryGwPoints(entryId, throughGw) : 0;
    const rank = start + i + 1; // stub ranks in entryIds order — good enough for a fixture server
    return {
      id: entryId,
      entry: entryId,
      entry_name: `Entry ${entryId}`,
      player_name: `Test Manager ${entryId}`,
      rank,
      last_rank: rank,
      rank_sort: rank,
      total,
      event_total: eventTotal,
    };
  });

  // The stub never simulates a manager joining mid-season, so new_entries is always empty but
  // still paginated correctly (has_next: false on page 1) — real, not omitted, shape.
  return {
    status: 200,
    body: {
      league: { id: fplLeagueId, name: league.name, start_event: league.startEvent, closed: false },
      new_entries: { has_next: false, page: pageNewEntries, results: [] },
      standings: { has_next: hasNextStandings, page: pageStandings, results },
      last_updated_data: new Date().toISOString(),
    },
  };
}

function entryPicks(entryId: number, gw: number) {
  const picks = Array.from({ length: 15 }, (_, i) => {
    const position = i + 1;
    const element = 1 + hashed(entryId * 31 + position * 13 + gw, TOTAL_ELEMENTS);
    return {
      element,
      position,
      multiplier: position <= 11 ? (position === 1 ? 2 : 1) : 0,
      is_captain: position === 1,
      is_vice_captain: position === 2,
    };
  });

  const points = entryGwPoints(entryId, gw);
  return {
    active_chip: null,
    automatic_subs: [],
    entry_history: {
      event: gw,
      points,
      total_points: points * gw,
      rank: 1 + hashed(entryId + gw, 500_000),
      event_transfers: hashed(entryId + gw * 2, 3),
      event_transfers_cost: entryTransferCost(entryId, gw),
    },
    picks,
  };
}

function liveGameweek(gw: number) {
  return {
    elements: Array.from({ length: TOTAL_ELEMENTS }, (_, i) => {
      const id = i + 1;
      const pts = elementPoints(id, gw);
      return {
        id,
        stats: {
          total_points: pts,
          minutes: pts > 0 ? 90 : 0,
          goals_scored: pts > 8 ? 1 : 0,
          assists: 0,
          clean_sheets: pts > 5 ? 1 : 0,
          bonus: pts > 10 ? 1 : 0,
        },
      };
    }),
  };
}

/**
 * FPL's /event-status/ payload: one row per match day of the current gameweek.
 *
 * The stub emits a single row for the latest settled GW, which is enough to drive
 * `isGameweekConcluded` — it asks whether every row for a GW has bonus_added and
 * whether `leagues` reads "Updated".
 */
function eventStatus() {
  const bonusThrough = state.bonusAddedThrough ?? state.finishedThrough;
  const rows = [];
  // Report the most recent few gameweeks; callers only ever look up one.
  const from = Math.max(1, state.finishedThrough - 2);
  for (let gw = from; gw <= Math.max(from, state.finishedThrough); gw++) {
    if (state.finishedThrough === 0) break;
    const bonusAdded = gw <= bonusThrough;
    rows.push({
      event: gw,
      bonus_added: bonusAdded,
      points: bonusAdded ? "r" : "p",
      date: stubDeadline(gw).toISOString().slice(0, 10),
    });
  }
  // "Updated" only once every reported GW has its bonus in — otherwise FPL is
  // still recalculating, and a spec setting bonusAddedThrough below
  // finishedThrough expects the gameweek to read as NOT concluded.
  const leagues = rows.length > 0 && rows.every((r) => r.bonus_added) ? "Updated" : "Updating";
  return { status: rows, leagues };
}

function allFixtures() {
  const out = [];
  for (let gw = 1; gw <= 38; gw++) {
    const finished = gw <= state.finishedThrough;
    // Kickoffs track the deadline, except for GWs a spec has explicitly marked
    // finished or live via /control — those are pushed into the past so
    // players-left and live-score logic see them as started.
    const live = state.liveGw === gw;
    for (let m = 0; m < 10; m++) {
      // A live GW splits: the first half have kicked off, the rest are still
      // to come — so "players left to play" is genuinely non-zero, which is
      // what the fixtures/dashboard indicator needs to be exercised.
      const played = finished || (live && m < 5);
      const kickoff = (
        played
          ? new Date(Date.now() - 2 * 3600 * 1000)
          : live
          ? new Date(Date.now() + 2 * 3600 * 1000)
          : new Date(stubDeadline(gw).getTime() + 3 * 3600 * 1000)
      ).toISOString();
      out.push({
        id: gw * 100 + m,
        event: gw,
        kickoff_time: kickoff,
        team_h: (m * 2) + 1,
        team_a: (m * 2) + 2,
        team_h_score: finished ? hashed(gw * 10 + m, 4) : null,
        team_a_score: finished ? hashed(gw * 10 + m + 1, 4) : null,
        // On a live GW leave the back half unstarted so players-left is non-zero.
        started: played,
        finished,
        finished_provisional: finished,
      });
    }
  }
  return out;
}

/**
 * Bucket a request by route SHAPE rather than exact path: entry ids would
 * otherwise make the counter map unbounded and useless to assert against.
 */
function countKey(segments: string[]): string {
  if (segments[0] === "entry") {
    if (segments[2] === "history") return "entry/history";
    if (segments[4] === "picks") return "entry/picks";
    if (segments.length === 2) return "entry";
  }
  if (segments[0] === "event" && segments[2] === "live") return "event/live";
  // Bucketed by shape, not id — a spec paging through a 120-entrant league makes several calls
  // to different ids/pages, and they must all count as the same "shape" for a call budget assert.
  if (segments[0] === "leagues-classic" && segments[2] === "standings") return "leagues-classic/standings";
  return segments.join("/");
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!isEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { path } = await ctx.params;
  const segments = (path ?? []).filter(Boolean);
  const joined = segments.join("/");

  // Counted before dispatch so 404s show up too -- a spec asserting "zero
  // calls" should fail on a misrouted call, not silently ignore it.
  if (joined !== "control") {
    const key = countKey(segments);
    state.counts[key] = (state.counts[key] ?? 0) + 1;
  }

  if (joined === "bootstrap-static") return NextResponse.json(bootstrap());
  if (joined === "fixtures") return NextResponse.json(allFixtures());
  if (joined === "event-status") return NextResponse.json(eventStatus());
  if (joined === "control") return NextResponse.json(state);

  if (segments[0] === "event" && segments[2] === "live") {
    return NextResponse.json(liveGameweek(Number(segments[1])));
  }

  if (segments[0] === "entry") {
    const entryId = Number(segments[1]);
    if (!Number.isFinite(entryId)) {
      return NextResponse.json({ detail: "Not found." }, { status: 404 });
    }
    if (segments[2] === "history") return NextResponse.json(entryHistory(entryId));
    if (segments[2] === "event" && segments[4] === "picks") {
      return NextResponse.json(entryPicks(entryId, Number(segments[3])));
    }
    if (segments.length === 2) {
      return NextResponse.json({
        id: entryId,
        player_first_name: "Test",
        player_last_name: `Manager ${entryId}`,
        name: `Entry ${entryId}`,
        summary_overall_points: hashed(entryId, 2000),
        summary_overall_rank: 1 + hashed(entryId * 3, 1_000_000),
      });
    }
  }

  if (segments[0] === "leagues-classic" && segments[2] === "standings") {
    const fplLeagueId = Number(segments[1]);
    if (!Number.isFinite(fplLeagueId)) {
      return NextResponse.json({ detail: "Not found." }, { status: 404 });
    }
    const pageStandings = Math.max(1, Number(request.nextUrl.searchParams.get("page_standings") ?? 1));
    const pageNewEntries = Math.max(1, Number(request.nextUrl.searchParams.get("page_new_entries") ?? 1));
    const { status, body } = classicLeagueStandings(fplLeagueId, pageStandings, pageNewEntries);
    return NextResponse.json(body, { status });
  }

  return NextResponse.json({ detail: "Not found.", path: joined }, { status: 404 });
}

/**
 * Drop the caches derived from the simulated FPL world.
 *
 * Without this, /control silently lies whenever a test Redis is configured.
 * `fetchBootstrapEventFlags` serves `fpl:events:latest` for 10 minutes and
 * `fetchBootstrapData` serves `fpl:bootstrap:latest` for a day, so a spec that
 * sets finishedThrough=3 goes on being reasoned about as finishedThrough=0 —
 * the submission gate and the FPL League header gameweek both read straight
 * through those two keys.
 *
 * Those TTLs are correct in production, where the real FPL changes slowly.
 * Here the world genuinely changes the instant a spec says so, so the derived
 * state has to go with it.
 *
 * Deliberately NOT cleared here: `fpl:history:*`. Entry history is keyed per entry rather than
 * per gameweek, and the caching specs assert that a second page load makes zero FPL calls — they
 * call /control to reset counters immediately beforehand, so wiping history on every world change
 * would break the very behaviour under test. fpl-league.spec.ts's "gameweek column" test relies
 * on exactly this: entryHistory's content depends only on max(finishedThrough, liveGw), and a
 * /control call that leaves that max unchanged must leave the cached history untouched too, or
 * the test's warm single-flight has nothing to serve. See `invalidateHistoryCache` below for the
 * one case that DOES need history swept.
 */
async function invalidateWorldDerivedCaches(): Promise<void> {
  const redis = await connectStubRedis();
  if (!redis) return;

  await redis.del("fpl:events:latest", "fpl:bootstrap:latest", "fpl:event-status:latest", "fpl:fixtures:all");
  for (const pattern of ["fpl:elements:gw*", "live:gw*", "fpl:deadline-sync:*"]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}

/**
 * Sweep cached entry histories.
 *
 * Split out from `invalidateWorldDerivedCaches` on purpose — see that function's docblock. This
 * one fires ONLY when `chipOverrides` itself changes: unlike `current[]` (a function of
 * finishedThrough/liveGw alone), the `chips[]` array is a function of chipOverrides, so a spec
 * that swaps a manager's simulated chip plan needs the old cached copy gone or the scorer and
 * every cache-only reader keep serving the pre-swap chips.
 */
async function invalidateHistoryCache(): Promise<void> {
  const redis = await connectStubRedis();
  if (!redis) return;

  const keys = await redis.keys("fpl:history:*");
  if (keys.length > 0) await redis.del(...keys);
}

async function connectStubRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // No cache configured — nothing to invalidate.

  const { Redis } = await import("@upstash/redis");
  return new Redis({ url, token });
}

/** POST /api/test-fpl-stub/control — drive the stub from a spec. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!isEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { path } = await ctx.params;
  if ((path ?? []).join("/") !== "control") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as Partial<StubState> & {
    resetCounts?: boolean;
  };
  // Only a change to the simulated world needs cache invalidation. A bare
  // `resetCounts` must not trigger it — the caching specs reset counters
  // immediately before asserting that a warm page makes zero FPL calls.
  let worldChanged = false;
  if (typeof body.finishedThrough === "number" && body.finishedThrough !== state.finishedThrough) {
    state.finishedThrough = body.finishedThrough;
    worldChanged = true;
  }
  if (body.bonusAddedThrough === null || typeof body.bonusAddedThrough === "number") {
    const next = body.bonusAddedThrough ?? null;
    if (next !== state.bonusAddedThrough) {
      state.bonusAddedThrough = next;
      worldChanged = true;
    }
  }
  if (body.liveGw === null || typeof body.liveGw === "number") {
    const next = body.liveGw ?? null;
    if (next !== state.liveGw) {
      state.liveGw = next;
      worldChanged = true;
    }
  }
  // Deliberately its own flag, not folded into worldChanged: it drives a DIFFERENT sweep
  // (invalidateHistoryCache), which must not fire on a bare finishedThrough/liveGw change — see
  // invalidateWorldDerivedCaches' docblock for why that would break fpl-league.spec.ts.
  let chipOverridesChanged = false;
  if (body.chipOverrides && typeof body.chipOverrides === "object") {
    state.chipOverrides = body.chipOverrides;
    chipOverridesChanged = true;
  }
  // Outright replacement, like chipOverrides — a spec that wants a small, deterministic roster
  // for one test must be able to say so without merging against the 120-entrant default.
  if (body.classicLeagues && typeof body.classicLeagues === "object") {
    state.classicLeagues = body.classicLeagues;
  }
  if (body.resetCounts) state.counts = {};

  if (worldChanged) await invalidateWorldDerivedCaches();
  if (chipOverridesChanged) await invalidateHistoryCache();

  return NextResponse.json(state);
}
