/**
 * TVT chip vs FPL chip clash, and wasted-chip detection.
 *
 * The league rule is that a team's TVT chip is wasted if EITHER manager played any FPL chip in
 * the same gameweek. Two things these tests pin hardest:
 *
 *  - the rule is team-wide, so one manager's chip voids the team's;
 *  - missing history is NOT evidence of no chip, so an unreadable side never triggers waste.
 *    Getting that backwards silently steals league points from teams whose data was cold.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  fplChipsPlayedInGw,
  tvtChipWasteReason,
  tvtChipWasteReasonFor,
} from "../../src/lib/formats/tvt/fpl-chip-clash";
import { isChipWasted, isChipDisclosable } from "../../src/lib/formats/tvt/chip-waste";
import type { FplChipStatus } from "../../src/lib/fpl-league/chips";

/** A manager who played `code` in `gw`, and nothing else. */
function played(code: string, gw: number): FplChipStatus {
  return { used: [{ code, gw }], available: [] };
}
const NOTHING: FplChipStatus = { used: [], available: ["WC1", "WC2", "BB", "TC", "FH", "AM"] };

/* ── the clash is team-wide ─────────────────────────────────────────────── */

test("one manager's FPL chip voids the team's TVT chip", () => {
  assert.deepEqual(fplChipsPlayedInGw([played("BB", 5), NOTHING], 5), ["BB"]);
  assert.equal(
    tvtChipWasteReasonFor([played("BB", 5), NOTHING], 5, "Double Pointer"),
    "Double Pointer wasted — Bench Boost played the same gameweek",
  );
});

test("either manager triggers it — order is irrelevant", () => {
  const a = tvtChipWasteReasonFor([NOTHING, played("TC", 7)], 7, "Win-Win");
  const b = tvtChipWasteReasonFor([played("TC", 7), NOTHING], 7, "Win-Win");
  assert.equal(a, b);
  assert.equal(a, "Win-Win wasted — Triple Captain played the same gameweek");
});

test("both managers playing names both chips, deduplicated and stably ordered", () => {
  assert.deepEqual(fplChipsPlayedInGw([played("TC", 3), played("BB", 3)], 3), ["BB", "TC"]);
  // Same chip on both sides collapses to one.
  assert.deepEqual(fplChipsPlayedInGw([played("BB", 3), played("BB", 3)], 3), ["BB"]);
  assert.equal(
    tvtChipWasteReasonFor([played("TC", 3), played("BB", 3)], 3, "Challenge Chip"),
    "Challenge Chip wasted — Bench Boost + Triple Captain played the same gameweek",
  );
});

test("no FPL chip means no clash", () => {
  assert.deepEqual(fplChipsPlayedInGw([NOTHING, NOTHING], 5), []);
  assert.equal(tvtChipWasteReasonFor([NOTHING, NOTHING], 5, "Double Pointer"), null);
});

test("a chip played in a DIFFERENT gameweek does not clash", () => {
  assert.deepEqual(fplChipsPlayedInGw([played("BB", 4), played("TC", 6)], 5), []);
  assert.equal(tvtChipWasteReasonFor([played("BB", 4)], 5, "Win-Win"), null);
});

/* ── missing data is not evidence ───────────────────────────────────────── */

test("null statuses are ignored, and an all-null side never triggers waste", () => {
  // The cold-cache case. Voiding here would cost a team real points for our missing data.
  assert.deepEqual(fplChipsPlayedInGw([null, undefined], 5), []);
  assert.equal(tvtChipWasteReasonFor([null, undefined], 5, "Double Pointer"), null);
  // A readable manager still counts even when their partner is unreadable.
  assert.equal(
    tvtChipWasteReasonFor([null, played("FH", 5)], 5, "Double Pointer"),
    "Double Pointer wasted — Free Hit played the same gameweek",
  );
});

/* ── every FPL chip counts ──────────────────────────────────────────────── */

test("all six FPL chips void a TVT chip, each named in the reason", () => {
  const expected: Record<string, string> = {
    WC1: "Wildcard 1", WC2: "Wildcard 2", BB: "Bench Boost",
    TC: "Triple Captain", FH: "Free Hit", AM: "Assistant Manager",
  };
  for (const [code, label] of Object.entries(expected)) {
    assert.equal(
      tvtChipWasteReasonFor([played(code, 9)], 9, "Win-Win"),
      `Win-Win wasted — ${label} played the same gameweek`,
      `${code} should void the chip`,
    );
  }
});

test("a chip FPL adds mid-season still voids, labelled by its raw code", () => {
  // buildFplChipStatus passes unknown names through rather than dropping them.
  assert.equal(
    tvtChipWasteReasonFor([played("newchip", 2)], 2, "Win-Win"),
    "Win-Win wasted — newchip played the same gameweek",
  );
});

test("tvtChipWasteReason on an empty code list is null", () => {
  assert.equal(tvtChipWasteReason([], "Win-Win"), null);
});

/* ── wasted-chip detection across all three stored shapes ───────────────── */

const CLEAN = { isProcessed: true, isValid: true, hadNegativeHits: false, wastedReason: null };

test("isChipWasted accepts all three representations", () => {
  // 1. The scorer's new shape.
  assert.equal(isChipWasted({ ...CLEAN, wastedReason: "Win-Win wasted — Bench Boost" }), true);
  // 2. Win-Win negative hits, and the admin import which sets the same flag for any wasted chip.
  assert.equal(isChipWasted({ ...CLEAN, hadNegativeHits: true }), true);
  // 3. The admin import / override shape.
  assert.equal(isChipWasted({ ...CLEAN, isValid: false }), true);
  // A normally scored chip is not wasted.
  assert.equal(isChipWasted(CLEAN), false);
  // An empty reason string is not a reason.
  assert.equal(isChipWasted({ ...CLEAN, wastedReason: "" }), false);
});

test("a rejected declaration is neither wasted nor disclosable", () => {
  // Invalid AND unprocessed: submission rejected it, so it was never played. Showing it would
  // tell the league a team spent a chip it still holds.
  const rejected = { isProcessed: false, isValid: false, hadNegativeHits: false, wastedReason: null };
  assert.equal(isChipWasted(rejected), false);
  assert.equal(isChipDisclosable(rejected), false);
});

test("valid chips and wasted chips are both disclosable", () => {
  assert.equal(isChipDisclosable(CLEAN), true);
  assert.equal(isChipDisclosable({ ...CLEAN, isValid: false }), true);
  assert.equal(isChipDisclosable({ ...CLEAN, wastedReason: "wasted" }), true);
  // wastedReason is optional on the interface — a caller that omits it still works.
  assert.equal(isChipDisclosable({ isProcessed: true, isValid: true, hadNegativeHits: false }), true);
});
