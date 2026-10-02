/**
 * Builds the compact per-manager facts behind the fixtures page's GW stats sidebar.
 *
 * Picks come from the picks cache the live sweep fills, so during a live gameweek this costs
 * nothing extra. Transfers are the one new FPL read (one call per manager), and are paid once
 * per gameweek — see fpl-live/transfers.ts. A build that could not read everyone says so
 * (`picksComplete` / `transfersComplete`) rather than presenting a partial league as the whole.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gameweeks, groups, leagues, players, teams } from "@/lib/db/schema";
import {
  fetchClubInfo,
  fetchElementGameweekDetail,
  fetchElementInfo,
  isGameweekFinal,
  type FPLGameweekPicks,
} from "@/lib/fpl";
import { getCachedPicksMany } from "@/lib/fpl-cache";
import { resolveLiveMultipliers, resolveSettledMultipliers, type LiveElementStat } from "@/lib/fpl-live/manager-points";
import { getManagerPicks } from "@/lib/fpl-live/picks-cache";
import { getFplFixturesForGw } from "@/lib/fpl-live/players-left";
import { getTransfersForGameweek } from "@/lib/fpl-live/transfers";
import { FplUnavailableError, withFplBudget } from "@/lib/fpl/gateway";
import { mapWithConcurrency } from "@/lib/concurrency";
import { concludedClubs } from "@/lib/match-center/team-sheet";
import {
  PICK_CAPTAIN,
  PICK_VICE,
  type GwStatsElement,
  type GwStatsManager,
  type GwStatsPayload,
} from "./aggregate";

/** Most FPL fetches one build may make for each of picks and transfers. A TVT-32 league is 64. */
const MAX_FETCH = 70;

export const STATS_FORMATS = ["tvt", "continental-championship"] as const;

export class GwStatsError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
  }
}

export async function resolveStatsTarget(leagueSlug: string, gwNumber: number) {
  const [league] = await db
    .select({ id: leagues.id, format: leagues.format })
    .from(leagues)
    .where(eq(leagues.slug, leagueSlug))
    .limit(1);
  if (!league) throw new GwStatsError(404, "League not found");
  if (!(STATS_FORMATS as readonly string[]).includes(league.format ?? "tvt")) {
    throw new GwStatsError(404, "Stats are not available for this league");
  }
  const gwRows = await db
    .select({ id: gameweeks.id, number: gameweeks.number, deadline: gameweeks.deadline })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, league.id));
  const gw = gwRows.find((g) => g.number === gwNumber);
  if (!gw) throw new GwStatsError(404, `Gameweek ${gwNumber} not found`);
  return { league, gw };
}

export async function buildGwStats(opts: {
  leagueId: string;
  format: string;
  gwNumber: number;
  deadline: Date;
  now?: Date;
}): Promise<GwStatsPayload> {
  const now = opts.now ?? new Date();
  const base = { gameweek: opts.gwNumber, generatedAt: now.toISOString() };
  if (opts.deadline.getTime() > now.getTime()) {
    return { ...base, status: "upcoming", settled: false, managers: [], elements: {}, picksComplete: true, transfersComplete: true };
  }

  const roster = await db
    .select({
      fplId: players.fplId,
      name: players.name,
      teamId: teams.id,
      teamName: teams.name,
      isGhost: teams.isGhost,
      groupName: groups.name,
    })
    .from(players)
    .innerJoin(teams, eq(players.teamId, teams.id))
    .leftJoin(groups, eq(teams.groupId, groups.id))
    .where(eq(teams.leagueId, opts.leagueId));
  const managersRoster = roster.filter((r) => !r.isGhost);
  const fplIds = managersRoster.map((r) => r.fplId);

  const settled = await isGameweekFinal(opts.gwNumber, "background");

  // ── Picks: cache first, then FPL for whatever the sweep has not warmed ──
  const picks = new Map<string, FPLGameweekPicks>();
  const cachedPicks = await getCachedPicksMany(fplIds, opts.gwNumber).catch(() => new Map());
  for (const [id, entry] of cachedPicks) {
    if (entry.settled || !settled) picks.set(id, entry.picks);
  }
  const missing = fplIds.filter((id) => !picks.has(id)).slice(0, MAX_FETCH);
  if (missing.length > 0) {
    try {
      await withFplBudget({ lane: "background", label: `gw-stats picks gw${opts.gwNumber}`, max: missing.length }, () =>
        mapWithConcurrency(missing, 4, async (id) => {
          try {
            picks.set(id, await getManagerPicks(id, opts.gwNumber, { lane: "background", settled }));
          } catch (err) {
            if (err instanceof FplUnavailableError) throw err;
          }
        }),
      );
    } catch (err) {
      if (!(err instanceof FplUnavailableError)) throw err;
    }
  }

  const transfers = await getTransfersForGameweek(fplIds, opts.gwNumber, opts.deadline, {
    lane: "background",
    maxFetch: MAX_FETCH,
    label: `gw-stats transfers gw${opts.gwNumber}`,
  });

  // ── Element data: names, clubs, this gameweek's points ──
  const [detail, elementInfo, clubInfo, gwFixtures] = await Promise.all([
    fetchElementGameweekDetail(opts.gwNumber, "background").catch(() => ({}) as Awaited<ReturnType<typeof fetchElementGameweekDetail>>),
    fetchElementInfo("background").catch(() => []),
    fetchClubInfo("background").catch(() => []),
    getFplFixturesForGw(opts.gwNumber),
  ]);
  const clubShort = new Map(clubInfo.map((c) => [c.id, c.short_name]));
  const infoById = new Map(elementInfo.map((e) => [e.id, e]));
  const stats: Record<number, LiveElementStat> = {};
  for (const [id, d] of Object.entries(detail)) stats[Number(id)] = { points: d.p, minutes: d.m };
  const statOf = (el: number) => stats[el] ?? { points: 0, minutes: 0 };
  const concluded = concludedClubs(gwFixtures, clubShort.keys());
  const concludedElements = new Set(elementInfo.filter((e) => concluded.has(e.team)).map((e) => e.id));

  const referenced = new Set<number>();
  const managers: GwStatsManager[] = managersRoster.map((r) => {
    const p = picks.get(r.fplId) ?? null;
    let packed: GwStatsManager["picks"] = null;
    let gross: number | null = null;
    if (p) {
      // Fill in zero stats for picks that never featured, so the resolver sees 0 minutes.
      for (const pick of p.picks) stats[pick.element] ??= statOf(pick.element);
      const resolved = settled
        ? resolveSettledMultipliers(p, stats)
        : resolveLiveMultipliers(p, { stats, concludedElements });
      packed = resolved.map((x) => [
        x.element,
        x.multiplier,
        (x.is_captain ? PICK_CAPTAIN : 0) | (x.is_vice_captain ? PICK_VICE : 0),
      ]);
      gross = settled ? p.entry_history.points : resolved.reduce((s, x) => s + statOf(x.element).points * x.multiplier, 0);
      for (const x of resolved) referenced.add(x.element);
    }
    const t = transfers.get(r.fplId) ?? null;
    if (t) for (const el of [...t.in, ...t.out]) referenced.add(el);
    return {
      fplId: r.fplId,
      name: r.name,
      teamId: r.teamId,
      teamName: r.teamName,
      group: opts.format === "tvt" ? r.groupName ?? null : null,
      picks: packed,
      chip: p?.active_chip ?? null,
      hits: p?.entry_history.event_transfers_cost ?? 0,
      gross,
      transfers: t,
    };
  });

  const elements: Record<number, GwStatsElement> = {};
  for (const id of referenced) {
    const info = infoById.get(id);
    elements[id] = {
      n: info?.web_name ?? `#${id}`,
      pos: info?.element_type ?? 0,
      club: info ? clubShort.get(info.team) ?? "" : "",
      pts: statOf(id).points,
    };
  }

  return {
    ...base,
    status: "ok",
    settled,
    managers,
    elements,
    picksComplete: managers.every((m) => m.picks !== null),
    transfersComplete: managers.every((m) => m.transfers !== null),
  };
}
