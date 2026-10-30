/**
 * Admin saves through an Upstash outage (invalidateLeaguePageCache / repairStalePageCaches in
 * lib/fpl-cache.ts).
 *
 * Regression cover for the Oct 2026 quota outage: superadmin Activate/Deactivate committed the
 * change, then the page-cache sweep after it threw, so the admin got "Failed to update league"
 * for a save that had happened. These pin the replacement: the sweep never throws, a refused one
 * is recorded, and the first page read after recovery sweeps it before serving anything, so no
 * page cached before the save survives the outage.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { __resetRedisForTests, BREAKER_OPEN_MS, isRedisDown } from "../../src/lib/redis";
import {
  __setStalePageCacheStoreForTests,
  getCachedFixtures,
  getCachedPlayoffBracket,
  getCachedStandings,
  invalidateLeaguePageCache,
  setCachedFixtures,
  setCachedLeagueStageRows,
  setCachedPlayoffBracket,
  setCachedStandings,
  type StalePageCacheStore,
} from "../../src/lib/fpl-cache";

/** Upstash stand-in: refuses everything while `failing`; `onDel` runs inside every DEL. */
class FakeRedis {
  data = new Map<string, unknown>();
  failing = false;
  onDel: (() => void) | null = null;

  private guard() {
    if (this.failing) throw new Error("ERR max requests limit exceeded");
  }
  async get<T>(key: string): Promise<T | null> {
    this.guard();
    return (this.data.get(key) as T) ?? null;
  }
  async set(key: string, value: unknown) {
    this.guard();
    this.data.set(key, value);
    return "OK";
  }
  async del(...keys: string[]) {
    this.guard();
    this.onDel?.();
    for (const k of keys) this.data.delete(k);
    return keys.length;
  }
  async keys(pattern: string): Promise<string[]> {
    this.guard();
    const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return [...this.data.keys()].filter((k) => re.test(k));
  }
}

/** The database record, in memory. Clears only the marking it is handed, like the real one. */
class FakeStore implements StalePageCacheStore {
  marks = new Map<string, string>();
  listCalls = 0;
  /** When set, list() waits on it — to hold a repair in flight. */
  gate: Promise<void> | null = null;
  private seq = 0;

  async mark(leagueId: string) {
    this.marks.set(leagueId, `t${++this.seq}`);
  }
  async list() {
    this.listCalls++;
    if (this.gate) await this.gate;
    return [...this.marks].map(([leagueId, markedAt]) => ({ leagueId, markedAt }));
  }
  async clear(leagueId: string, markedAt: string) {
    if (this.marks.get(leagueId) === markedAt) this.marks.delete(leagueId);
  }
  leagues() {
    return [...this.marks.keys()].sort();
  }
}

/** Virtual clock over Date.now, which is all the breaker and the repair timer read. */
const realNow = Date.now;
let clock = 1_000_000;
function startClock() {
  clock = 1_000_000;
  Date.now = () => clock;
}
function advance(ms: number) {
  clock += ms;
}

function setup() {
  startClock();
  const fake = new FakeRedis();
  __resetRedisForTests(fake);
  const store = new FakeStore();
  __setStalePageCacheStoreForTests(store);
  return { fake, store };
}

/** One of each page cache a league keeps: standings, fixtures, playoffs, league-stage rows. */
async function seedPages(leagueId: string) {
  await setCachedStandings(leagueId, 9, { standings: "before the save" });
  await setCachedFixtures(leagueId, 9, { fixtures: "before the save" });
  await setCachedPlayoffBracket(leagueId, { bracket: "before the save" });
  await setCachedLeagueStageRows(leagueId, 9, [{ rows: "before the save" }]);
}

const keysOf = (fake: FakeRedis, leagueId: string) => [...fake.data.keys()].filter((k) => k.includes(`:${leagueId}`));

test.afterEach(() => {
  Date.now = realNow;
  __resetRedisForTests(null);
  __setStalePageCacheStoreForTests(null);
});

test("a refused sweep does not throw, and records the league for repair", async () => {
  const { fake, store } = setup();
  fake.failing = true;
  await invalidateLeaguePageCache("league-a");
  assert.deepEqual(store.leagues(), ["league-a"]);
  assert.ok(isRedisDown(), "a refusal opens the breaker like any other");
});

test("a sweep that gets through clears all four page caches of that league only", async () => {
  const { fake, store } = setup();
  await seedPages("league-a");
  await seedPages("league-b");
  await invalidateLeaguePageCache("league-a");
  assert.deepEqual(keysOf(fake, "league-a"), []);
  assert.equal(keysOf(fake, "league-b").length, 4);
  assert.deepEqual(store.leagues(), [], "nothing owed");
});

test("once Upstash answers again, the next page read sweeps a recorded league before reading", async () => {
  const { fake, store } = setup();
  await seedPages("league-a");
  fake.failing = true;
  await invalidateLeaguePageCache("league-a");
  assert.equal(keysOf(fake, "league-a").length, 4, "the pre-save pages outlive the outage");

  fake.failing = false;
  advance(BREAKER_OPEN_MS + 1);
  assert.equal(await getCachedStandings("league-a", 9), null, "pre-save standings are never served");
  assert.deepEqual(keysOf(fake, "league-a"), []);
  assert.deepEqual(store.leagues(), [], "the record goes once swept");
});

test("the record is not read while Upstash is down, and at most once a minute while it answers", async () => {
  const { fake, store } = setup();
  fake.failing = true;
  await invalidateLeaguePageCache("league-a");
  await getCachedStandings("league-a", 9);
  await getCachedFixtures("league-a", 9);
  assert.equal(store.listCalls, 0, "an open breaker costs no database reads");

  fake.failing = false;
  advance(BREAKER_OPEN_MS + 1);
  await getCachedStandings("league-a", 9);
  await getCachedFixtures("league-a", 9);
  await getCachedPlayoffBracket("league-a");
  assert.equal(store.listCalls, 1, "one read for a burst of page loads");

  advance(60_000);
  await getCachedStandings("league-a", 9);
  assert.equal(store.listCalls, 2);
});

test("without Upstash configured nothing is recorded and nothing is read", async () => {
  startClock();
  __resetRedisForTests(null);
  const store = new FakeStore();
  __setStalePageCacheStoreForTests(store);
  await invalidateLeaguePageCache("league-a");
  await getCachedStandings("league-a", 9);
  assert.deepEqual(store.leagues(), []);
  assert.equal(store.listCalls, 0);
});

test("a repair that Upstash refuses leaves every league recorded for the next pass", async () => {
  const { fake, store } = setup();
  await store.mark("league-a");
  await store.mark("league-b");
  fake.failing = true;
  assert.equal(await getCachedStandings("league-a", 9), null);
  assert.deepEqual(store.leagues(), ["league-a", "league-b"]);
  assert.ok(isRedisDown());
});

test("page reads that arrive during a repair wait for it rather than serving what it will delete", async () => {
  const { fake, store } = setup();
  await seedPages("league-a");
  await store.mark("league-a");
  let release!: () => void;
  store.gate = new Promise<void>((resolve) => (release = resolve));

  const standings = getCachedStandings("league-a", 9);
  const fixtures = getCachedFixtures("league-a", 9); // arrives while the repair is still reading
  release();
  assert.deepEqual(await Promise.all([standings, fixtures]), [null, null]);
  assert.equal(store.listCalls, 1);
  assert.deepEqual(keysOf(fake, "league-a"), []);
});

test("a league recorded again while its sweep runs keeps the newer record", async () => {
  const { fake, store } = setup();
  await store.mark("league-a");
  const swept = store.marks.get("league-a");
  fake.onDel = () => {
    fake.onDel = null;
    void store.mark("league-a"); // another save, refused, lands mid-sweep
  };
  await getCachedStandings("league-a", 9);
  assert.deepEqual(store.leagues(), ["league-a"]);
  assert.notEqual(store.marks.get("league-a"), swept);
});
