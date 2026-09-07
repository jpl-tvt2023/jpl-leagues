/**
 * The forced-refresh single-flight slot.
 *
 * Regression cover for the "clicking Refresh does nothing" report. `releaseRefreshSlot` leaves a
 * cooldown behind rather than deleting the key, so a burst of near-simultaneous clicks coalesces
 * onto the result the first one produced. That is correct and load-bearing — the e2e spec
 * "concurrent refreshes coalesce into a single FPL sweep" depends on it.
 *
 * What was wrong was its LENGTH. At 60s the cooldown spanned an entire human interaction: for a
 * minute after any sweep — including the automatic background one the fixtures page fires on a
 * stale poll — a manual Refresh lost the claim and got the same cached payload back, which the
 * client then rendered as a completed forced refresh.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";

/** Minimal stand-in for the two Upstash calls fpl-cache makes on this key. */
class FakeRedis {
  store = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, opts?: { ex?: number; nx?: boolean }) {
    const existing = this.store.get(key);
    if (existing && existing.expiresAt <= this.now) this.store.delete(key);
    if (opts?.nx && this.store.has(key)) return null;
    this.store.set(key, { value, expiresAt: this.now + (opts?.ex ?? 0) * 1000 });
    return "OK";
  }

  /** Virtual clock, so expiry is asserted without sleeping. */
  now = 0;
  advance(seconds: number) {
    this.now += seconds * 1000;
  }
}

const KEY = "live:refresh:lock:gw7:league-1";
const REFRESH_LOCK_TTL = 120;
const REFRESH_RESULT_TTL = 10;

const claim = async (r: FakeRedis) =>
  (await r.set(KEY, "1", { ex: REFRESH_LOCK_TTL, nx: true })) !== null;
const release = async (r: FakeRedis) =>
  void (await r.set(KEY, "1", { ex: REFRESH_RESULT_TTL }));

test("only one concurrent caller wins the slot", async () => {
  const r = new FakeRedis();
  assert.equal(await claim(r), true);
  assert.equal(await claim(r), false);
  assert.equal(await claim(r), false);
});

test("a straggler arriving just after the winner released still coalesces", async () => {
  const r = new FakeRedis();
  assert.equal(await claim(r), true);
  await release(r);
  r.advance(1);
  // This is the burst the cooldown exists to absorb — one sweep, not two.
  assert.equal(await claim(r), false);
});

test("the cooldown expires well inside a human interaction", async () => {
  const r = new FakeRedis();
  assert.equal(await claim(r), true);
  await release(r);

  // At 60s this was still locked out, which is the reported bug: a reader who looked
  // at the numbers and clicked again got the same payload and no explanation.
  r.advance(REFRESH_RESULT_TTL + 1);
  assert.equal(await claim(r), true, "a deliberate second click must be able to sweep");
});

test("a background refresh does not lock the user out for a minute", async () => {
  const r = new FakeRedis();
  // Poll went stale -> background sweep runs and completes.
  assert.equal(await claim(r), true);
  await release(r);
  // User clicks Refresh 15 seconds later. Under the old 60s cooldown this was refused.
  r.advance(15);
  assert.equal(await claim(r), true);
});

test("the cooldown is far shorter than the fresh window it used to rival", async () => {
  const LIVE_CACHE_TTL = 60 * 10;
  assert.ok(
    REFRESH_RESULT_TTL < LIVE_CACHE_TTL / 10,
    "a cooldown approaching the fresh window makes forced refresh meaningless"
  );
});
