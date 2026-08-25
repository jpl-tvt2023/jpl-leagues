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
const globalForStub = globalThis as typeof globalThis & { __fplStubState?: StubState };
const state: StubState = (globalForStub.__fplStubState ??= {
  finishedThrough: 0,
  bonusAddedThrough: null,
  liveGw: null,
  counts: {},
});
// A server that was already running before counts existed keeps its old
// globalThis object, so the field can be genuinely absent here.
state.counts ??= {};
// Same reason as `counts`: a server started before this field existed keeps its
// old globalThis object, where the property is genuinely absent.
state.bonusAddedThrough ??= null;

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
  for (const [name, gw] of chipPlan) {
    if (gw <= throughGw && hashed(entryId + gw * 17, 2) === 0) {
      chips.push({ name, time: new Date(Date.UTC(2026, 7, 14 + gw * 7)).toISOString(), event: gw });
    }
  }

  return { current, past: [], chips };
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
 * Deliberately NOT cleared: `fpl:history:*`. Entry history is keyed per entry
 * rather than per gameweek, and the caching specs assert that a second page
 * load makes zero FPL calls — they call /control to reset counters immediately
 * beforehand, so wiping history here would break the very behaviour under test.
 */
async function invalidateWorldDerivedCaches(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return; // No cache configured — nothing to invalidate.

  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({ url, token });

  await redis.del("fpl:events:latest", "fpl:bootstrap:latest", "fpl:event-status:latest", "fpl:fixtures:all");
  for (const pattern of ["fpl:elements:gw*", "live:gw*", "fpl:deadline-sync:*"]) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
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
  if (body.resetCounts) state.counts = {};

  if (worldChanged) await invalidateWorldDerivedCaches();

  return NextResponse.json(state);
}
