/**
 * What the app does when Upstash stops answering (lib/redis.ts).
 *
 * Regression cover for the Oct 2026 quota exhaustion: every command threw, almost every read sat
 * outside a try, and the fixtures page rendered empty while the live routes returned 500. These
 * pin the three states — absent, up, down — and the two jobs of the in-process L1: read-through
 * for hot keys, and last-good while down, never older than the value's own Redis TTL.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  __resetRedisForTests,
  BREAKER_OPEN_MS,
  cachedGet,
  cachedMget,
  cachedSet,
  isRedisDown,
  redisClaim,
  redisRead,
  redisRelease,
  redisWritable,
} from "../../src/lib/redis";

/** Upstash stand-in: counts calls, and refuses everything while `failing`. */
class FakeRedis {
  data = new Map<string, unknown>();
  calls: string[] = [];
  failing = false;

  private guard(call: string) {
    this.calls.push(call);
    if (this.failing) throw new Error("ERR max requests limit exceeded");
  }
  async get<T>(key: string): Promise<T | null> {
    this.guard(`get ${key}`);
    return (this.data.get(key) as T) ?? null;
  }
  async mget<T>(...keys: string[]): Promise<T> {
    this.guard(`mget ${keys.join(",")}`);
    return keys.map((k) => this.data.get(k) ?? null) as T;
  }
  async set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }) {
    this.guard(`set ${key}${opts?.nx ? " nx" : ""}`);
    if (opts?.nx && this.data.has(key)) return null;
    this.data.set(key, value);
    return "OK";
  }
  async del(...keys: string[]) {
    this.guard(`del ${keys.join(",")}`);
    for (const k of keys) this.data.delete(k);
    return keys.length;
  }
  async ping() {
    this.guard("ping");
    return "PONG";
  }
}

/** Virtual clock over Date.now, which is all lib/redis.ts reads. */
const realNow = Date.now;
let clock = 1_000_000;
function startClock() {
  clock = 1_000_000;
  Date.now = () => clock;
}
function advance(ms: number) {
  clock += ms;
}

function setup(): FakeRedis {
  startClock();
  const fake = new FakeRedis();
  __resetRedisForTests(fake);
  return fake;
}

test.afterEach(() => {
  Date.now = realNow;
  __resetRedisForTests(null);
  delete process.env.TEST_FPL_STUB;
});

/* ── Absent ─────────────────────────────────────────────────────────────── */

test("absent: reads miss, claims succeed, writability is not in question", async () => {
  startClock();
  __resetRedisForTests(null);
  assert.equal(await cachedGet("k"), null);
  assert.deepEqual(await cachedMget(["a", "b"]), [null, null]);
  assert.equal(await redisRead("k", "fallback", async () => "never"), "fallback");
  assert.equal(await redisClaim("lock", 60, async () => false), true, "no Redis → nothing to coalesce");
  assert.equal(await redisWritable(), true);
});

/* ── Up ─────────────────────────────────────────────────────────────────── */

test("up: a hot key is read once per L1 window, then from Redis again", async () => {
  const fake = setup();
  fake.data.set("fpl:fixtures:all", [1, 2, 3]);

  assert.deepEqual(await cachedGet("fpl:fixtures:all", { l1Seconds: 30 }), [1, 2, 3]);
  assert.deepEqual(await cachedGet("fpl:fixtures:all", { l1Seconds: 30 }), [1, 2, 3]);
  assert.equal(fake.calls.length, 1, "the second read inside the window is served in-process");

  advance(31_000);
  await cachedGet("fpl:fixtures:all", { l1Seconds: 30 });
  assert.equal(fake.calls.length, 2, "past the window it asks Redis again");
});

test("up: a key without l1Seconds is always read from Redis", async () => {
  const fake = setup();
  fake.data.set("live:gw9:lg", { cachedAt: "x" });
  await cachedGet("live:gw9:lg");
  await cachedGet("live:gw9:lg");
  assert.equal(fake.calls.length, 2);
});

test("up: mget serves L1 hits and asks Redis only for the rest, aligned with the input", async () => {
  const fake = setup();
  fake.data.set("h:1", { id: 1 });
  fake.data.set("h:2", { id: 2 });
  await cachedMget(["h:1"], { l1Seconds: 60 }); // warms h:1 only
  fake.calls = [];

  const out = await cachedMget<{ id: number }>(["h:1", "h:2", "h:3"], { l1Seconds: 60 });
  assert.deepEqual(out, [{ id: 1 }, { id: 2 }, null]);
  assert.deepEqual(fake.calls, ["mget h:2,h:3"]);
});

/* ── Down ───────────────────────────────────────────────────────────────── */

test("a failing read is a miss, opens the breaker, and stops all traffic until it closes", async () => {
  const fake = setup();
  fake.failing = true;

  assert.equal(await cachedGet("k"), null);
  assert.equal(isRedisDown(), true);
  assert.equal(await redisRead("k2", "fallback", (r) => r.get("k2")), "fallback");
  assert.equal(fake.calls.length, 1, "while open, nothing is sent at all");

  fake.failing = false;
  advance(BREAKER_OPEN_MS + 1);
  assert.equal(isRedisDown(), false);
  fake.data.set("k", "v");
  assert.equal(await cachedGet("k"), "v", "after the window it tries again, and recovers");
});

test("down: a value this instance wrote is served as last-good for its TTL, never longer", async () => {
  const fake = setup();
  await cachedSet("live:gw9:lg", { cachedAt: "t0" }, 3600, { lastGood: true });

  fake.failing = true;
  assert.deepEqual(await cachedGet("live:gw9:lg"), { cachedAt: "t0" });

  advance(3601_000);
  assert.equal(await cachedGet("live:gw9:lg"), null, "older than its Redis TTL is never served");
});

test("down: a hot key read earlier is kept only for its read-through window", async () => {
  const fake = setup();
  fake.data.set("fpl:bootstrap:latest", ["el"]);
  await cachedGet("fpl:bootstrap:latest", { l1Seconds: 300 });

  fake.failing = true;
  advance(299_000);
  assert.deepEqual(await cachedGet("fpl:bootstrap:latest", { l1Seconds: 300 }), ["el"]);
  advance(2_000);
  assert.equal(await cachedGet("fpl:bootstrap:latest", { l1Seconds: 300 }), null);
});

test("down: page blobs read via redisRead have no last-good — they recompute from the database", async () => {
  const fake = setup();
  fake.data.set("standings:v3:lg:d9", { rows: [] });
  assert.deepEqual(await redisRead("s", null, (r) => r.get("standings:v3:lg:d9")), { rows: [] });

  fake.failing = true;
  assert.equal(await redisRead("s", null, (r) => r.get("standings:v3:lg:d9")), null);
});

test("a Redis miss drops this instance's copy, so a deleted key is never resurrected later", async () => {
  const fake = setup();
  await cachedSet("live:gw9:lg", { cachedAt: "t0" }, 3600, { lastGood: true });
  fake.data.delete("live:gw9:lg"); // invalidated by another instance

  assert.equal(await cachedGet("live:gw9:lg"), null);
  fake.failing = true;
  assert.equal(await cachedGet("live:gw9:lg"), null);
});

test("writes never throw and never trip the breaker", async () => {
  const fake = setup();
  fake.failing = true;
  await cachedSet("k", "v", 60); // must resolve
  assert.equal(isRedisDown(), false, "an oversized or refused write says nothing about reads");
});

/* ── Claims ─────────────────────────────────────────────────────────────── */

test("down: claims hold in-process with their TTL, and a release frees them", async () => {
  const fake = setup();
  fake.failing = true;

  const claim = () =>
    redisClaim("live:refresh:lock:gw9:lg", 120, async (r) => (await r.set("x", "1", { nx: true })) !== null);
  assert.equal(await claim(), true, "first caller wins");
  assert.equal(await claim(), false, "a second caller on the same instance is coalesced");

  await redisRelease("live:refresh:lock:gw9:lg", (r) => r.del("x"));
  assert.equal(await claim(), true, "released");

  advance(121_000);
  assert.equal(await claim(), true, "and a held claim lapses on its TTL");
});

test("a release with a cooldown keeps the claim held for the cooldown", async () => {
  const fake = setup();
  fake.failing = true;
  const claim = () => redisClaim("slot", 120, async (r) => (await r.set("slot", "1", { nx: true })) !== null);
  assert.equal(await claim(), true);
  await redisRelease("slot", async () => undefined, 10);
  assert.equal(await claim(), false);
  advance(10_001);
  assert.equal(await claim(), true);
});

test("redisWritable: false while Redis refuses, so scoring stops before writing", async () => {
  const fake = setup();
  assert.equal(await redisWritable(), true);
  fake.failing = true;
  assert.equal(await redisWritable(), false);
});

/* ── Stub runs ──────────────────────────────────────────────────────────── */

test("the L1 is off under TEST_FPL_STUB — specs change the simulated world between requests", async () => {
  const fake = setup();
  process.env.TEST_FPL_STUB = "1";
  fake.data.set("fpl:fixtures:all", [1]);
  await cachedGet("fpl:fixtures:all", { l1Seconds: 30 });
  fake.data.set("fpl:fixtures:all", [2]);
  assert.deepEqual(await cachedGet("fpl:fixtures:all", { l1Seconds: 30 }), [2]);
});
