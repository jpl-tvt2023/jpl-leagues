import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { isSuperAdmin } from "@/lib/auth";
import {
  fplRequest,
  FPL_BASE_URL,
  FplUnavailableError,
  getFplGatewayState,
  withFplBudget,
} from "@/lib/fpl/gateway";
import { getActiveFplGameweek } from "@/lib/fpl/event-status";
import { isScoringActive } from "@/lib/fpl-cache";

/**
 * GET /api/admin/fpl-probe[?gw=N]
 *
 * Superadmin only. Exercises each dependency the live-score sweep needs, one at
 * a time, and reports what each one did.
 *
 * Why this exists: live scores vanished across the whole app while every
 * individual piece looked healthy from outside. The sweep's only failure path
 * was a catch that logged the error and returned an empty payload, so a
 * gateway refusal, a crashed FPL fetch and a gameweek with nothing to compute
 * were byte-identical in the response. There was no way to tell which without
 * reading Vercel logs during the incident.
 *
 * The probes run INDEPENDENTLY and each swallows its own failure — the whole
 * point is to see which single step is broken, so one failing step must never
 * abort the rest.
 *
 * Read-only with respect to application data. The Redis probe writes and then
 * deletes its own throwaway key; it touches nothing the app reads.
 */

export const maxDuration = 30;

interface ProbeResult {
  ok: boolean;
  ms: number;
  status?: number;
  bytes?: number;
  error?: string;
  note?: string;
}

/**
 * Time one probe and capture its outcome.
 *
 * `FplUnavailableError` is reported distinctly: it means the gateway declined
 * before any request left the process, which is a different diagnosis from FPL
 * itself rejecting us, and conflating the two is what made this hard to chase.
 */
async function probe(fn: () => Promise<Omit<ProbeResult, "ok" | "ms">>): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const out = await fn();
    return { ok: out.status === undefined || out.status < 400, ms: Date.now() - started, ...out };
  } catch (e) {
    const error =
      e instanceof FplUnavailableError
        ? `gateway declined (${e.reason}) — no request was made`
        : e instanceof Error
          ? e.message
          : "unknown error";
    return { ok: false, ms: Date.now() - started, error };
  }
}

/** Fetch an FPL endpoint and report its status and payload size. */
async function probeFpl(path: string): Promise<Omit<ProbeResult, "ok" | "ms">> {
  const res = await fplRequest(`${FPL_BASE_URL}${path}`, { lane: "background" });
  const body = await res.text();
  return {
    status: res.status,
    bytes: body.length,
    ...(res.ok ? {} : { error: `HTTP ${res.status}: ${body.slice(0, 200)}` }),
  };
}

/**
 * Round-trip a payload the size of one gameweek's element stats.
 *
 * Sized deliberately: the two writes that follow every `/event/{gw}/live/`
 * fetch are ~700-entry maps, and a backend that accepts a small key but
 * rejects those is precisely the failure this is looking for.
 */
async function probeRedis(): Promise<Omit<ProbeResult, "ok" | "ms">> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return { error: "UPSTASH_REDIS_REST_URL / _TOKEN not configured", note: "cache disabled" };
  }
  const r = new Redis({ url, token });
  const key = `fpl:probe:${Date.now()}`;
  const payload: Record<number, { points: number; minutes: number }> = {};
  for (let i = 1; i <= 700; i++) payload[i] = { points: 0, minutes: 0 };

  try {
    await r.set(key, payload, { ex: 60 });
    const read = await r.get<Record<number, { points: number; minutes: number }>>(key);
    const bytes = JSON.stringify(payload).length;
    if (!read) return { bytes, error: "write succeeded but read returned nothing" };
    return { bytes, note: `${Object.keys(read).length} entries round-tripped` };
  } finally {
    await r.del(key).catch(() => {});
  }
}

export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin only" }, { status: 403 });
  }

  // Resolve the gameweek first, so the live probe targets whatever FPL is
  // actually on rather than a guess. Falls back to 1 if FPL cannot say.
  const gwParam = Number(request.nextUrl.searchParams.get("gw"));
  let gw = Number.isFinite(gwParam) && gwParam >= 1 && gwParam <= 38 ? gwParam : null;
  let activeGwDetail = "not consulted (gw given explicitly)";
  if (gw === null) {
    const active = await getActiveFplGameweek().catch(() => null);
    gw = active?.gw ?? 1;
    activeGwDetail = active ? `${active.source}: ${active.detail}` : "getActiveFplGameweek threw";
  }

  // The budget mirrors what a real sweep runs under, so a probe cannot itself
  // trip anything, and `withFplBudget` logs one summary line per run.
  const steps = await withFplBudget(
    { lane: "background", label: "fpl-probe", max: 10 },
    async () => ({
      // Controls: these were healthy throughout the incident, so a failure here
      // means something much broader than the live endpoint is wrong.
      bootstrap: await probe(() => probeFpl("/bootstrap-static/")),
      fixtures: await probe(() => probeFpl("/fixtures/")),
      eventStatus: await probe(() => probeFpl("/event-status/")),
      // The suspect: the only FPL call on the sweep's path not covered above.
      liveGw: await probe(() => probeFpl(`/event/${gw}/live/`)),
      // The other suspect: the unguarded cache writes that follow it.
      redisWrite: await probe(probeRedis),
    })
  );

  const gateway = getFplGatewayState();
  const scoringLocked = await isScoringActive().catch(() => false);

  const failed = Object.entries(steps)
    .filter(([, v]) => !v.ok)
    .map(([k]) => k);

  return NextResponse.json({
    gw,
    activeGwDetail,
    steps,
    gateway: {
      ...gateway,
      scoringLocked,
      // Either of these refuses every background call before it is made, which
      // presents as "live scores missing" with no error anywhere.
      refusingBackgroundCalls: gateway.breakerOpen || scoringLocked,
    },
    failed,
    verdict:
      failed.length === 0
        ? "All dependencies healthy — a failure now is not in these steps."
        : `Failing: ${failed.join(", ")}`,
    checkedAt: new Date().toISOString(),
  });
}
