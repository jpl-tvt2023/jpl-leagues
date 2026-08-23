/**
 * Link helpers. These encode two bugs that shipped, so the cases below are
 * regressions, not hypotheticals.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fplEntryUrl, fplEntryLabel, FPL_ALLOWED_PATH } from "../../src/lib/fpl-links";

test("a real gameweek produces an event URL", () => {
  assert.equal(
    fplEntryUrl("12345", 7),
    "https://fantasy.premierleague.com/entry/12345/event/7"
  );
  assert.equal(
    fplEntryUrl(12345, 1),
    "https://fantasy.premierleague.com/entry/12345/event/1"
  );
});

test("gameweek 0 falls back to history rather than /event/0", () => {
  // The shipped bug: callers wrote `gw || undefined`, and at GW1 the
  // "last completed GW" is 0, so the points link silently became /history.
  assert.equal(fplEntryUrl("12345", 0), "https://fantasy.premierleague.com/entry/12345/history");
  assert.equal(fplEntryUrl("12345", null), "https://fantasy.premierleague.com/entry/12345/history");
  assert.equal(fplEntryUrl("12345"), "https://fantasy.premierleague.com/entry/12345/history");
  assert.equal(fplEntryUrl("12345", NaN), "https://fantasy.premierleague.com/entry/12345/history");
});

test("labels never render GW0", () => {
  // The other shipped bug: `lastCompletedGw ?? (gw - 1)` — 0 is not nullish,
  // so the pill read "GW0" for the whole of gameweek 1.
  assert.equal(fplEntryLabel(0), "History");
  assert.equal(fplEntryLabel(null), "History");
  assert.equal(fplEntryLabel(undefined), "History");
  assert.equal(fplEntryLabel(1), "GW1");
  assert.equal(fplEntryLabel(38), "GW38");
});

test("the redirect allow-list accepts only FPL entry paths", () => {
  assert.ok(FPL_ALLOWED_PATH.test("entry/12345/event/7"));
  assert.ok(FPL_ALLOWED_PATH.test("entry/1/history"));

  // Open-redirect attempts and anything else must be refused.
  for (const bad of [
    "entry/12345/event/7/../../evil",
    "../evil",
    "https://evil.example.com",
    "entry/abc/event/7",
    "entry/12345/event/999",
    "entry/12345/transfers",
    "",
  ]) {
    assert.equal(FPL_ALLOWED_PATH.test(bad), false, `should refuse: ${bad}`);
  }
});
