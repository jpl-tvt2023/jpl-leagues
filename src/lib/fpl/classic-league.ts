/**
 * FPL classic mini-league standings — `leagues-classic/{id}/standings/`.
 *
 * This is the ONLY endpoint the FPL Classic league format needs at read time: it returns every
 * entrant's current-gameweek and season totals in a handful of calls, which is what makes public,
 * unauthenticated, on-demand reads affordable — see the cost comparison in
 * src/lib/fpl-classic/sync.ts.
 *
 * Three things about the raw payload that will bite if unhandled:
 *
 *  1. Pagination is 50 rows per page (`standings.has_next` / `page_standings`).
 *  2. `new_entries` paginates INDEPENDENTLY (`page_new_entries`) — one loop does not cover both.
 *  3. `new_entries` is not a subset of `standings`. A manager who joined since FPL last
 *     recomputed the league's ranks appears ONLY in `new_entries`, absent from
 *     `standings.results` entirely. The roster this module returns is the UNION, deduped by
 *     `entry`, standings order preserved — this is the trap most implementations miss.
 *
 * All HTTP goes through the gateway; this module never calls `fetch` directly.
 */

import { fplRequest, FPL_BASE_URL, type FplLane } from "@/lib/fpl/gateway";

export class FplClassicLeagueNotFoundError extends Error {
  readonly fplLeagueId: number;
  constructor(fplLeagueId: number) {
    super(`No FPL classic league with id ${fplLeagueId}`);
    this.name = "FplClassicLeagueNotFoundError";
    this.fplLeagueId = fplLeagueId;
  }
}

export interface FplClassicStandingRow {
  entry: number;
  entryName: string;
  playerName: string;
  rank: number;
  lastRank: number;
  rankSort: number;
  total: number;
  eventTotal: number;
}

export interface FplClassicNewEntry {
  entry: number;
  entryName: string;
  playerName: string;
  joinedTime: string | null;
}

export interface FplClassicLeagueMeta {
  id: number;
  name: string;
  startEvent: number;
  closed: boolean;
}

export interface FplClassicStandingsPayload {
  league: FplClassicLeagueMeta;
  /** standings ∪ new_entries, deduped by `entry`. Standings order first, then unmatched new entries. */
  entries: FplClassicStandingRow[];
  newEntries: FplClassicNewEntry[];
  lastUpdatedData: string | null;
  /** True when a page cap was hit — the roster returned is incomplete, not wrong. */
  truncated: boolean;
  pagesFetched: number;
}

/* ── raw wire shapes (snake_case, as FPL sends them) ─────────────────────── */

interface RawStandingsResult {
  entry: number;
  entry_name: string;
  player_name: string;
  rank: number;
  last_rank: number;
  rank_sort: number;
  total: number;
  event_total: number;
}
interface RawStandingsPage {
  has_next: boolean;
  page: number;
  results: RawStandingsResult[];
}
interface RawNewEntryResult {
  entry: number;
  entry_name: string;
  player_first_name: string;
  player_last_name: string;
  joined_time?: string | null;
}
interface RawNewEntriesPage {
  has_next: boolean;
  page: number;
  results: RawNewEntryResult[];
}
interface RawLeague {
  id: number;
  name: string;
  start_event: number;
  closed: boolean;
}

/**
 * Pure merge: standings ∪ new_entries, deduped by entry id, extracted so it unit-tests without
 * HTTP. `standingsPages`/`newEntryPages` are already-fetched pages, in page order.
 */
export function mergeClassicPages(
  standingsPages: RawStandingsPage[],
  newEntryPages: RawNewEntriesPage[],
  league: RawLeague,
): Omit<FplClassicStandingsPayload, "pagesFetched" | "truncated"> {
  const entries: FplClassicStandingRow[] = [];
  const seen = new Set<number>();

  for (const page of standingsPages) {
    for (const r of page.results) {
      if (seen.has(r.entry)) continue;
      seen.add(r.entry);
      entries.push({
        entry: r.entry,
        entryName: r.entry_name,
        playerName: r.player_name,
        rank: r.rank,
        lastRank: r.last_rank,
        rankSort: r.rank_sort,
        total: r.total,
        eventTotal: r.event_total,
      });
    }
  }

  const newEntries: FplClassicNewEntry[] = [];
  for (const page of newEntryPages) {
    for (const r of page.results) {
      newEntries.push({
        entry: r.entry,
        entryName: r.entry_name,
        playerName: `${r.player_first_name} ${r.player_last_name}`.trim(),
        joinedTime: r.joined_time ?? null,
      });
      // A manager present ONLY in new_entries (FPL hasn't recomputed ranks for them yet) still
      // belongs in the roster — with zero standings data, since none exists yet.
      if (!seen.has(r.entry)) {
        seen.add(r.entry);
        entries.push({
          entry: r.entry,
          entryName: r.entry_name,
          playerName: `${r.player_first_name} ${r.player_last_name}`.trim(),
          rank: 0,
          lastRank: 0,
          rankSort: 0,
          total: 0,
          eventTotal: 0,
        });
      }
    }
  }

  return {
    league: { id: league.id, name: league.name, startEvent: league.start_event, closed: league.closed },
    entries,
    newEntries,
    lastUpdatedData: null,
  };
}

/**
 * Fetch and page through a classic league's standings. Must be called inside `withFplBudget` —
 * it does no budgeting of its own, matching every other fetcher in `lib/fpl.ts`.
 */
export async function fetchClassicLeagueStandings(
  fplLeagueId: number,
  opts?: { lane?: FplLane; maxStandingsPages?: number; maxNewEntryPages?: number },
): Promise<FplClassicStandingsPayload> {
  const lane = opts?.lane ?? "background";
  const maxStandingsPages = opts?.maxStandingsPages ?? 20; // 20 * 50 = 1000 entrants
  const maxNewEntryPages = opts?.maxNewEntryPages ?? 5;

  const standingsPages: RawStandingsPage[] = [];
  const newEntryPages: RawNewEntriesPage[] = [];
  let league: RawLeague | null = null;
  let lastUpdatedData: string | null = null;
  let pagesFetched = 0;
  let truncated = false;

  // page_standings and page_new_entries paginate independently, but the FIRST call carries both
  // page 1s plus the league meta, so it doubles as existence-check and first page of each.
  let standingsPage = 1;
  let newEntriesPage = 1;
  let standingsDone = false;
  let newEntriesDone = false;

  while (!standingsDone || !newEntriesDone) {
    const url =
      `${FPL_BASE_URL}/leagues-classic/${fplLeagueId}/standings/` +
      `?page_standings=${standingsDone ? 1 : standingsPage}` +
      `&page_new_entries=${newEntriesDone ? 1 : newEntriesPage}`;

    const res = await fplRequest(url, { lane });
    pagesFetched++;

    if (res.status === 404) throw new FplClassicLeagueNotFoundError(fplLeagueId);
    if (!res.ok) throw new Error(`FPL classic-league standings request failed: ${res.status}`);

    const raw = (await res.json()) as {
      league?: RawLeague;
      standings?: RawStandingsPage;
      new_entries?: RawNewEntriesPage;
      last_updated_data?: string | null;
    };

    if (!raw.league) throw new FplClassicLeagueNotFoundError(fplLeagueId);
    league = raw.league;
    if (raw.last_updated_data) lastUpdatedData = raw.last_updated_data;

    if (!standingsDone && raw.standings) {
      standingsPages.push(raw.standings);
      if (raw.standings.has_next && standingsPage < maxStandingsPages) {
        standingsPage++;
      } else {
        if (raw.standings.has_next) truncated = true;
        standingsDone = true;
      }
    } else {
      standingsDone = true;
    }

    if (!newEntriesDone && raw.new_entries) {
      newEntryPages.push(raw.new_entries);
      if (raw.new_entries.has_next && newEntriesPage < maxNewEntryPages) {
        newEntriesPage++;
      } else {
        if (raw.new_entries.has_next) truncated = true;
        newEntriesDone = true;
      }
    } else {
      newEntriesDone = true;
    }
  }

  if (!league) throw new FplClassicLeagueNotFoundError(fplLeagueId);

  const merged = mergeClassicPages(standingsPages, newEntryPages, league);
  return { ...merged, lastUpdatedData, truncated, pagesFetched };
}
