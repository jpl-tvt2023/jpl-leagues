/**
 * How many points a manager has scored in a gameweek.
 *
 * Regression cover for "every live fixture shows 0-0". Between 2026-08-30 and 2026-09-13 the
 * live scorer read `entry_history.points` off the picks payload, which FPL holds at 0 for the
 * entire duration of an in-progress gameweek and fills in only when it settles the week. Every
 * TVT fixture, the dashboard card, the JPL Cup and the playoff bracket rendered 0-0 for three
 * gameweeks.
 *
 * The other half of the cover is the vice-captain handover. The recompute that was removed
 * handed the armband over whenever the captain had zero minutes, which is equally true of a
 * captain whose match has not kicked off — it inflated 23 of 64 managers on a live gameweek.
 * "captain yet to kick off keeps the armband" below is the assertion that must never go green
 * by accident.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  managerGameweekPoints,
  type ManagerPointsContext,
} from "../../src/lib/fpl-live/manager-points";
import type { FPLGameweekPicks } from "../../src/lib/fpl";

type PickSpec = {
  element: number;
  multiplier: number;
  is_captain?: boolean;
  is_vice_captain?: boolean;
};

function picksPayload(specs: PickSpec[], settledPoints: number): FPLGameweekPicks {
  return {
    active_chip: null,
    automatic_subs: [],
    entry_history: {
      event: 4,
      points: settledPoints,
      total_points: 300,
      rank: null,
      event_transfers: 0,
      event_transfers_cost: 0,
    },
    picks: specs.map((s, i) => ({
      element: s.element,
      position: i + 1,
      multiplier: s.multiplier,
      is_captain: s.is_captain ?? false,
      is_vice_captain: s.is_vice_captain ?? false,
    })),
  };
}

function ctx(
  stats: Record<number, { points: number; minutes: number }>,
  concluded: number[] = [],
  settled = false,
): ManagerPointsContext {
  return { settled, stats, concludedElements: new Set(concluded) };
}

test("live gameweek is recomputed, not read off entry_history", () => {
  // The exact shape FPL serves mid-gameweek: picks are real, points is 0.
  const picks = picksPayload(
    [
      { element: 1, multiplier: 2, is_captain: true },
      { element: 2, multiplier: 1, is_vice_captain: true },
      { element: 3, multiplier: 1 },
      { element: 9, multiplier: 0 }, // benched, must not count
    ],
    0,
  );
  const stats = {
    1: { points: 8, minutes: 90 },
    2: { points: 5, minutes: 90 },
    3: { points: 2, minutes: 45 },
    9: { points: 12, minutes: 90 },
  };

  assert.equal(managerGameweekPoints(picks, ctx(stats)), 8 * 2 + 5 + 2);
});

test("settled gameweek takes entry_history verbatim, even where the recompute would differ", () => {
  // Once FPL has processed the week its number includes bonus and auto-substitutions that
  // /event/{gw}/live/ never exposed, so it must win — and must match what the cron persists.
  const picks = picksPayload([{ element: 1, multiplier: 2, is_captain: true }], 71);
  const stats = { 1: { points: 8, minutes: 90 } };

  assert.equal(managerGameweekPoints(picks, ctx(stats, [1], true)), 71);
});

test("captain yet to kick off keeps the armband", () => {
  // The 23-of-64 inflation. Zero minutes alone must never trigger the handover: element 1's
  // club still has a fixture to play, so it is absent from concludedElements.
  const picks = picksPayload(
    [
      { element: 1, multiplier: 2, is_captain: true },
      { element: 2, multiplier: 1, is_vice_captain: true },
    ],
    0,
  );
  const stats = {
    1: { points: 0, minutes: 0 },
    2: { points: 9, minutes: 90 },
  };

  // 0 x 2 + 9, NOT 9 x 2.
  assert.equal(managerGameweekPoints(picks, ctx(stats, [2])), 9);
});

test("captain who has demonstrably blanked hands over to the vice-captain", () => {
  const picks = picksPayload(
    [
      { element: 1, multiplier: 2, is_captain: true },
      { element: 2, multiplier: 1, is_vice_captain: true },
    ],
    0,
  );
  const stats = {
    1: { points: 0, minutes: 0 },
    2: { points: 9, minutes: 90 },
  };

  // Both clubs are done; the captain played no part.
  assert.equal(managerGameweekPoints(picks, ctx(stats, [1, 2])), 18);
});

test("a captain who played and was booked to exactly zero keeps the armband", () => {
  // 1 for the appearance, -1 for the card. Points alone cannot distinguish this from a
  // player who never left the bench, which is why the gate reads minutes.
  const picks = picksPayload(
    [
      { element: 1, multiplier: 2, is_captain: true },
      { element: 2, multiplier: 1, is_vice_captain: true },
    ],
    0,
  );
  const stats = {
    1: { points: 0, minutes: 20 },
    2: { points: 9, minutes: 90 },
  };

  assert.equal(managerGameweekPoints(picks, ctx(stats, [1, 2])), 9);
});

test("triple captain transfers at x3 when the captain blanks", () => {
  const picks = picksPayload(
    [
      { element: 1, multiplier: 3, is_captain: true },
      { element: 2, multiplier: 1, is_vice_captain: true },
    ],
    0,
  );
  const stats = {
    1: { points: 0, minutes: 0 },
    2: { points: 7, minutes: 90 },
  };

  assert.equal(managerGameweekPoints(picks, ctx(stats, [1, 2])), 21);
});

test("bench boost counts all fifteen, because FPL has already set their multipliers", () => {
  const specs: PickSpec[] = Array.from({ length: 15 }, (_, i) => ({
    element: i + 1,
    multiplier: i === 0 ? 2 : 1,
    is_captain: i === 0,
    is_vice_captain: i === 1,
  }));
  const stats: Record<number, { points: number; minutes: number }> = {};
  for (let i = 1; i <= 15; i++) stats[i] = { points: 2, minutes: 90 };

  // 14 players at 2, plus the captain's 2 doubled.
  assert.equal(managerGameweekPoints(picksPayload(specs, 0), ctx(stats)), 14 * 2 + 4);
});

test("an element missing from the live payload contributes nothing rather than throwing", () => {
  const picks = picksPayload(
    [
      { element: 1, multiplier: 2, is_captain: true },
      { element: 404, multiplier: 1 },
    ],
    0,
  );

  assert.equal(managerGameweekPoints(picks, ctx({ 1: { points: 6, minutes: 90 } })), 12);
});

test("an empty concludedElements set never hands the armband over", () => {
  // How the context degrades when FPL's fixture list is unreachable. Late is recoverable;
  // early inflates every manager whose captain has not kicked off.
  const picks = picksPayload(
    [
      { element: 1, multiplier: 2, is_captain: true },
      { element: 2, multiplier: 1, is_vice_captain: true },
    ],
    0,
  );
  const stats = {
    1: { points: 0, minutes: 0 },
    2: { points: 9, minutes: 90 },
  };

  assert.equal(managerGameweekPoints(picks, ctx(stats, [])), 9);
});
