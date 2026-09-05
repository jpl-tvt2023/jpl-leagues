/**
 * The disclosure epoch used in cache keys.
 *
 * Several public payloads only reveal a chip once its gameweek's deadline has passed, then get
 * cached for hours and invalidated only by writes. A deadline passing is not a write, so the
 * verdict froze into the blob and chips stayed hidden for a whole TTL. Folding this count into
 * the cache key makes the key change the moment a deadline passes.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { disclosedGwCount } from "../../src/lib/gameweeks/disclosure";

const at = (iso: string) => ({ deadline: new Date(iso) });
const NOW = new Date("2026-09-05T00:00:00Z");

test("counts only gameweeks whose deadline has passed", () => {
  const gws = [at("2026-08-21T17:30:00Z"), at("2026-08-28T17:30:00Z"), at("2026-09-12T12:30:00Z")];
  assert.equal(disclosedGwCount(gws, NOW), 2);
});

test("the count ticks the moment a deadline passes — the whole point of the key", () => {
  const gws = [at("2026-08-21T17:30:00Z"), at("2026-09-04T17:30:00Z")];
  // One minute BEFORE GW2's deadline, then one minute after.
  assert.equal(disclosedGwCount(gws, new Date("2026-09-04T17:29:00Z")), 1);
  assert.equal(disclosedGwCount(gws, new Date("2026-09-04T17:31:00Z")), 2);
});

test("a deadline exactly now counts as disclosed", () => {
  assert.equal(disclosedGwCount([at("2026-09-05T00:00:00Z")], NOW), 1);
});

test("no gameweeks is zero, not a crash", () => {
  assert.equal(disclosedGwCount([], NOW), 0);
});

test("all future is zero, all past is every one", () => {
  const future = [at("2027-01-01T00:00:00Z"), at("2027-02-01T00:00:00Z")];
  const past = [at("2026-01-01T00:00:00Z"), at("2026-02-01T00:00:00Z")];
  assert.equal(disclosedGwCount(future, NOW), 0);
  assert.equal(disclosedGwCount(past, NOW), 2);
});

test("order does not matter — gameweeks are not assumed sorted", () => {
  const shuffled = [at("2026-09-12T12:30:00Z"), at("2026-08-21T17:30:00Z"), at("2026-09-04T17:30:00Z")];
  assert.equal(disclosedGwCount(shuffled, NOW), 2);
});
