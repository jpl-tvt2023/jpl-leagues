/**
 * FPL classic-league standings — merging paginated pages into one roster.
 *
 * The two traps this pins:
 *  - `new_entries` paginates INDEPENDENTLY of `standings` — three pages of one and one page of
 *    the other must still merge correctly;
 *  - a manager present ONLY in `new_entries` (FPL hasn't recomputed ranks yet) must still make
 *    the roster — the single easiest thing to get wrong when reading this endpoint.
 *
 * Run with: npm run test:unit
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mergeClassicPages } from "../../src/lib/fpl/classic-league";

const LEAGUE = { id: 900001, name: "Stub Classic", start_event: 1, closed: false };

function standingsPage(entries: number[], hasNext: boolean, page: number) {
  return {
    has_next: hasNext,
    page,
    results: entries.map((entry) => ({
      entry,
      entry_name: `Entry ${entry}`,
      player_name: `Player ${entry}`,
      rank: entry,
      last_rank: entry,
      rank_sort: entry,
      total: 1000 + entry,
      event_total: 50 + entry,
    })),
  };
}

function newEntriesPage(entries: number[], hasNext: boolean, page: number) {
  return {
    has_next: hasNext,
    page,
    results: entries.map((entry) => ({
      entry,
      entry_name: `New Entry ${entry}`,
      player_first_name: "First",
      player_last_name: `Last${entry}`,
      joined_time: "2025-11-01T00:00:00Z",
    })),
  };
}

test("three standings pages merge to a single ordered roster", () => {
  const pages = [
    standingsPage([1, 2], true, 1),
    standingsPage([3, 4], true, 2),
    standingsPage([5], false, 3),
  ];
  const out = mergeClassicPages(pages, [], LEAGUE);
  assert.deepEqual(out.entries.map((e) => e.entry), [1, 2, 3, 4, 5]);
});

test("an entry present in both standings and new_entries appears once", () => {
  const out = mergeClassicPages(
    [standingsPage([1, 2], false, 1)],
    [newEntriesPage([2, 3], false, 1)],
    LEAGUE,
  );
  // 2 was already seen from standings, so only 1, 2, 3 — never a duplicate 2.
  assert.deepEqual(out.entries.map((e) => e.entry), [1, 2, 3]);
  assert.equal(out.entries.filter((e) => e.entry === 2).length, 1);
});

test("an entry present ONLY in new_entries is included — the trap", () => {
  const out = mergeClassicPages(
    [standingsPage([1], false, 1)],
    [newEntriesPage([99], false, 1)],
    LEAGUE,
  );
  assert.deepEqual(out.entries.map((e) => e.entry).sort(), [1, 99]);
  const entry99 = out.entries.find((e) => e.entry === 99)!;
  // No standings data exists for them yet — zeros, not a crash, not an omission.
  assert.equal(entry99.total, 0);
  assert.equal(entry99.playerName, "First Last99");
});

test("new_entries paginates independently of standings", () => {
  const out = mergeClassicPages(
    [standingsPage([1, 2], false, 1)],
    [newEntriesPage([10], true, 1), newEntriesPage([11, 12], false, 2)],
    LEAGUE,
  );
  assert.equal(out.newEntries.length, 3);
  assert.deepEqual(out.newEntries.map((e) => e.entry), [10, 11, 12]);
});

test("league metadata is carried through unchanged", () => {
  const out = mergeClassicPages([standingsPage([1], false, 1)], [], LEAGUE);
  assert.deepEqual(out.league, { id: 900001, name: "Stub Classic", startEvent: 1, closed: false });
});

test("empty standings and empty new_entries yields an empty roster, not a crash", () => {
  const out = mergeClassicPages([], [], LEAGUE);
  assert.deepEqual(out.entries, []);
  assert.deepEqual(out.newEntries, []);
});
