/**
 * Client polls that stop while nobody is looking (lib/poll-while-visible.ts).
 *
 * A background tab used to poll every few minutes all day, each tick a function invocation and
 * its Redis reads. These pin the three behaviours that matter: hidden tabs skip ticks, a returning
 * reader is caught up at once, and the catch-up never doubles with the next scheduled tick.
 *
 * Run with: npm run test:unit
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { pollWhileVisible } from "../../src/lib/poll-while-visible";

/** Just enough of `document` for the helper: a hidden flag and visibilitychange listeners. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    setHidden(hidden: boolean) {
      doc.hidden = hidden;
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size,
  };
  (globalThis as unknown as { document: unknown }).document = doc;
  return doc;
}

const MIN = 60_000;

test.beforeEach(() => mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 }));
test.afterEach(() => {
  mock.timers.reset();
  delete (globalThis as { document?: unknown }).document;
});

test("polls on every interval while the tab is visible", () => {
  fakeDocument();
  let calls = 0;
  const stop = pollWhileVisible(() => calls++, 3 * MIN);
  mock.timers.tick(9 * MIN);
  assert.equal(calls, 3);
  stop();
});

test("a hidden tab skips its ticks entirely", () => {
  const doc = fakeDocument();
  let calls = 0;
  const stop = pollWhileVisible(() => calls++, 3 * MIN);
  doc.setHidden(true);
  mock.timers.tick(60 * MIN);
  assert.equal(calls, 0, "an hour in the background costs nothing");
  stop();
});

test("returning after a missed tick catches up at once, without doubling the next tick", () => {
  const doc = fakeDocument();
  let calls = 0;
  const stop = pollWhileVisible(() => calls++, 3 * MIN);
  doc.setHidden(true);
  mock.timers.tick(10 * MIN); // ticks at 3, 6, 9 skipped
  doc.setHidden(false);
  assert.equal(calls, 1, "caught up the moment the tab is shown");

  mock.timers.tick(2 * MIN); // the 12-minute tick lands 2 minutes after the catch-up
  assert.equal(calls, 1, "a tick right after the catch-up does not fetch again");
  mock.timers.tick(3 * MIN); // 15 minutes
  assert.equal(calls, 2);
  stop();
});

test("a brief tab switch inside one interval does not fetch early", () => {
  const doc = fakeDocument();
  let calls = 0;
  const stop = pollWhileVisible(() => calls++, 3 * MIN);
  mock.timers.tick(MIN);
  doc.setHidden(true);
  doc.setHidden(false);
  assert.equal(calls, 0);
  stop();
});

test("the cleanup stops the interval and removes its listener", () => {
  const doc = fakeDocument();
  let calls = 0;
  const stop = pollWhileVisible(() => calls++, 3 * MIN);
  stop();
  mock.timers.tick(30 * MIN);
  assert.equal(calls, 0);
  assert.equal(doc.listenerCount(), 0);
});
