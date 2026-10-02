/**
 * Tooltip placement.
 *
 * `placeTooltip` is the geometry behind every HelpTip bubble. Its one promise is that the bubble
 * never leaves the viewport — the Challenge Chip breakdown used to spill off the right edge of a
 * 360px phone, and the club-by-gameweek list off the bottom of the screen.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { placeTooltip } from "../../src/lib/tooltip-placement";

const PHONE = { width: 360, height: 780 };

/** A 20px-tall trigger whose top edge is at `top`, horizontally centred on `centerX`. */
function trigger(top: number, centerX = 180, width = 40) {
  return { top, bottom: top + 20, left: centerX - width / 2, width };
}

function assertInside(p: { top: number; left: number; maxHeight: number | null }, w: number, h: number, vp = PHONE) {
  const height = p.maxHeight ?? h;
  assert.ok(p.left >= 8, `left ${p.left} < 8`);
  assert.ok(p.left + w <= vp.width - 8, `right ${p.left + w} > ${vp.width - 8}`);
  assert.ok(p.top >= 8, `top ${p.top} < 8`);
  assert.ok(p.top + height <= vp.height - 8, `bottom ${p.top + height} > ${vp.height - 8}`);
}

test("opens below the trigger when it fits there", () => {
  const p = placeTooltip({ trigger: trigger(100), bubbleWidth: 200, naturalHeight: 150, viewport: PHONE });
  assert.equal(p.top, 128); // trigger bottom 120 + 8px gap
  assert.equal(p.maxHeight, null);
  assertInside(p, 200, 150);
});

test("flips above when there is no room below", () => {
  const p = placeTooltip({ trigger: trigger(600), bubbleWidth: 200, naturalHeight: 250, viewport: PHONE });
  assert.equal(p.top, 600 - 8 - 250);
  assert.equal(p.maxHeight, null);
  assertInside(p, 200, 250);
});

test("too tall for either side: takes the roomier side and caps its height", () => {
  // 38 gameweeks of club results: far taller than the phone.
  const below = placeTooltip({ trigger: trigger(200), bubbleWidth: 320, naturalHeight: 900, viewport: PHONE });
  assert.equal(below.top, 228);
  assert.equal(below.maxHeight, 780 - 8 - 228);
  assertInside(below, 320, 900);

  const above = placeTooltip({ trigger: trigger(560), bubbleWidth: 320, naturalHeight: 900, viewport: PHONE });
  assert.equal(above.maxHeight, 560 - 8 - 8);
  assert.equal(above.top, 8);
  assertInside(above, 320, 900);
});

test("a 420px challenge bubble clamped to a 360px phone sits inside the 8px gutters", () => {
  // HelpTip clamps the width to min(420, 360 - 16) = 344 before measuring.
  const p = placeTooltip({ trigger: trigger(300, 330), bubbleWidth: 344, naturalHeight: 200, viewport: PHONE });
  assert.equal(p.left, 8);
  assertInside(p, 344, 200);
});

test("triggers hugging either edge keep the bubble on screen", () => {
  const left = placeTooltip({ trigger: trigger(300, 12), bubbleWidth: 260, naturalHeight: 60, viewport: PHONE });
  assert.equal(left.left, 8);
  assertInside(left, 260, 60);

  const right = placeTooltip({ trigger: trigger(300, 350), bubbleWidth: 260, naturalHeight: 60, viewport: PHONE });
  assert.equal(right.left, 360 - 260 - 8);
  assertInside(right, 260, 60);
});

test("centres on the trigger when there is room", () => {
  const p = placeTooltip({ trigger: trigger(300, 500), bubbleWidth: 200, naturalHeight: 60, viewport: { width: 1280, height: 800 } });
  assert.equal(p.left, 400);
});

test("a trigger partly scrolled off the top still yields an on-screen bubble", () => {
  const p = placeTooltip({ trigger: { top: -15, bottom: 5, left: 160, width: 40 }, bubbleWidth: 200, naturalHeight: 100, viewport: PHONE });
  assertInside(p, 200, 100);
});
