/**
 * FPL request gateway.
 *
 * Every outbound call to the Fantasy Premier League API goes through here.
 * FPL publishes no rate limit and no quota — it is an undocumented endpoint
 * behind Cloudflare that returns 403/429 to aggressive or cloud-originated
 * traffic (which is why fpl.ts has always sent a User-Agent). Because the
 * limit is unknown we cannot budget against a number; instead this module
 * makes our outbound volume bounded, observable, and subordinate to scoring.
 *
 * Four mechanisms:
 *   1. Global concurrency cap + a minimum interval between requests.
 *   2. Lanes. "critical" is the scoring pipeline, whose failures write wrong
 *      league tables. "background" is everything user-facing. Under pressure,
 *      background loses.
 *   3. Circuit breaker on consecutive 429/403 responses.
 *   4. Scoring lock — while a scoring run holds fpl:scoring-active, every
 *      background call is refused outright so the run gets the whole budget.
 *
 * Callers in the background lane must treat rejection as normal and fall back
 * to cached/stale data or render "—". They must never surface it as an error.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isScoringActive } from "@/lib/fpl-cache";

export type FplLane = "critical" | "background";

/** Overridable so tests can point at a local fixture server. */
export const FPL_BASE_URL =
  process.env.FPL_BASE_URL ?? "https://fantasy.premierleague.com/api";

/** The real host — used only to detect an unmocked test run. */
const REAL_FPL_HOST = "fantasy.premierleague.com";

// FPL is friendlier to clients that identify themselves — requests without a
// User-Agent from cloud/serverless IPs (Vercel etc.) intermittently get rejected.
export const FPL_USER_AGENT =
  "Mozilla/5.0 (compatible; jpl-leagues/1.0; +https://jpl-leagues.vercel.app)";

const DEFAULT_TIMEOUT_MS = 10_000;
/** Max simultaneous in-flight FPL requests across the whole process. */
const MAX_CONCURRENCY = 4;
/** Floor on the gap between two request starts, to avoid bursty traffic. */
const MIN_INTERVAL_MS = 120;
/** Consecutive 429/403 responses before the breaker trips. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
/** Retries are for the critical lane only. */
const MAX_RETRIES = 2;

/** Thrown when the gateway declines to make a call. Never an FPL failure. */
export class FplUnavailableError extends Error {
  readonly reason: "breaker" | "scoring" | "budget";
  constructor(reason: "breaker" | "scoring" | "budget", message: string) {
    super(message);
    this.name = "FplUnavailableError";
    this.reason = reason;
  }
}

/* ── Concurrency + pacing ─────────────────────────────────────────────── */

let active = 0;
let lastStartedAt = 0;
const waiters: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pace(): Promise<void> {
  const wait = lastStartedAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastStartedAt = Date.now();
}

/* ── Circuit breaker ──────────────────────────────────────────────────── */

let consecutiveRejections = 0;
let breakerOpenUntil = 0;

function breakerIsOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

function noteRejection(): void {
  consecutiveRejections++;
  if (consecutiveRejections >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
    console.warn(
      `[fpl] circuit breaker tripped after ${consecutiveRejections} consecutive rejections; ` +
        `background calls refused for ${BREAKER_COOLDOWN_MS / 1000}s`
    );
  }
}

function noteSuccess(): void {
  consecutiveRejections = 0;
}

/** Test/ops escape hatch — resets breaker and pacing state. */
export function __resetFplGatewayState(): void {
  active = 0;
  waiters.length = 0;
  lastStartedAt = 0;
  consecutiveRejections = 0;
  breakerOpenUntil = 0;
}

/* ── Per-request budget + observability ───────────────────────────────── */

interface BudgetContext {
  lane: FplLane;
  label: string;
  max: number;
  calls: number;
  rejections: number;
}

const budgetStore = new AsyncLocalStorage<BudgetContext>();

/**
 * Run fn with a hard ceiling on how many FPL calls it may make, and log a
 * single summary line when it finishes. Exceeding max throws
 * FplUnavailableError("budget") rather than silently fanning out.
 */
export async function withFplBudget<T>(
  opts: { lane: FplLane; label: string; max: number },
  fn: () => Promise<T>
): Promise<T> {
  const ctx: BudgetContext = { ...opts, calls: 0, rejections: 0 };
  try {
    return await budgetStore.run(ctx, fn);
  } finally {
    if (ctx.calls > 0 || ctx.rejections > 0) {
      console.log(
        `[fpl] ${ctx.label} lane=${ctx.lane} calls=${ctx.calls}/${ctx.max} rejected=${ctx.rejections}`
      );
    }
  }
}

/* ── The gateway ──────────────────────────────────────────────────────── */

let scoringLockCheckedAt = 0;
let scoringLockValue = false;

/** Cache the scoring-lock lookup briefly so we do not add a Redis hop per call. */
async function scoringRunActive(): Promise<boolean> {
  if (Date.now() - scoringLockCheckedAt < 5_000) return scoringLockValue;
  try {
    scoringLockValue = await isScoringActive();
  } catch {
    scoringLockValue = false;
  }
  scoringLockCheckedAt = Date.now();
  return scoringLockValue;
}

function assertNotHittingRealFplInTests(url: string): void {
  // Deliberately NOT keyed on NODE_ENV: `next dev` forces it to "development"
  // even when .env.test says otherwise, so a NODE_ENV check silently never
  // arms and the suite quietly hits the real FPL API. TEST_FPL_STUB is set in
  // .env.test and nowhere else.
  if (process.env.TEST_FPL_STUB !== "1" && process.env.NODE_ENV !== "test") return;
  if (process.env.FPL_ALLOW_LIVE === "1") return;
  if (url.includes(REAL_FPL_HOST)) {
    throw new Error(
      `[fpl] refusing to call the live FPL API from a test run (${url}). ` +
        `Set FPL_BASE_URL to a fixture server, or FPL_ALLOW_LIVE=1 to override.`
    );
  }
}

/**
 * Make a single FPL request.
 *
 * Background-lane calls are refused (throwing FplUnavailableError) when the
 * breaker is open or a scoring run is in progress. Critical-lane calls are
 * always attempted and get retries with backoff.
 */
export async function fplRequest(
  url: string,
  opts: { lane: FplLane; timeoutMs?: number; signal?: AbortSignal }
): Promise<Response> {
  const { lane, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  assertNotHittingRealFplInTests(url);

  const ctx = budgetStore.getStore();

  if (lane === "background") {
    if (breakerIsOpen()) {
      if (ctx) ctx.rejections++;
      throw new FplUnavailableError("breaker", "FPL circuit breaker is open");
    }
    if (await scoringRunActive()) {
      if (ctx) ctx.rejections++;
      throw new FplUnavailableError("scoring", "a scoring run is in progress");
    }
  }

  if (ctx) {
    if (ctx.calls >= ctx.max) {
      ctx.rejections++;
      throw new FplUnavailableError(
        "budget",
        `${ctx.label} exceeded its FPL budget of ${ctx.max} calls`
      );
    }
    ctx.calls++;
  }

  // Retries differ by failure kind, not just by lane:
  //   - a 429/403 means the server is pushing back, so the background lane
  //     must not retry — that is exactly the traffic shape we are avoiding;
  //   - a thrown error is a connection-level failure (DNS, reset, timeout).
  //     Retrying that once does not add load against a rate limiter, and
  //     without it a single blip silently degrades a caller: the submission
  //     gate falls open for the whole league, for instance.
  const maxAttempts = lane === "critical" ? MAX_RETRIES + 1 : 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLastAttempt = attempt === maxAttempts - 1;
    await acquire();
    let res: Response;
    try {
      await pace();
      res = await fetchOnce(url, timeoutMs, signal);
    } catch (err) {
      release();
      if (isLastAttempt) throw err;
      await sleep(Math.min(250 * 2 ** attempt, 2_000));
      continue;
    }
    release();

    if (res.status === 429 || res.status === 403) {
      noteRejection();
      // Background never retries a rate-limit response.
      if (isLastAttempt || lane === "background") return res;
      await sleep(retryDelayMs(res, attempt));
      continue;
    }

    if (res.status >= 500 && !isLastAttempt && lane === "critical") {
      await sleep(retryDelayMs(res, attempt));
      continue;
    }

    if (res.ok) noteSuccess();
    return res;
  }

  // Unreachable — the loop always returns on its final attempt.
  throw new Error("[fpl] retry loop exhausted");
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

function fetchOnce(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  return fetch(url, {
    signal: controller.signal,
    cache: "no-store",
    headers: { "User-Agent": FPL_USER_AGENT },
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}
