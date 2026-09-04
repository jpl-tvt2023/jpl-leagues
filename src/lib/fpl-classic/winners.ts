/**
 * FPL Classic — the Winners page payload.
 *
 * Every award the league has, each labelled `final`, `provisional` or `leading`. The third state
 * is the reason this exists: the standings payload deliberately drops any scope that is not fully
 * settled, so an award still being contested was previously invisible. A reader wants to know who
 * is ahead in the month, and wants to be told plainly that it is not settled.
 *
 * ⚠️ Makes ZERO FPL calls. Everything here comes from fpl_classic_entrants, fpl_classic_entry_gws
 * and fpl_classic_awards — all local, all indexed. That is deliberate: this page is public and
 * unauthenticated, so a crawler hitting it must not be able to start FPL traffic. It also means
 * the numbers are "as at the last processed gameweek", which the payload states via
 * `settledThroughGw` so the page can say so rather than implying live figures. The in-flight
 * gameweek's live leader lives on the standings page's Manager of the Gameweek table.
 *
 * ⚠️ NO PRIZE, AMOUNT, OR CURRENCY FIELD EXISTS HERE, AND NONE MAY BE ADDED.
 */

import { db } from "@/lib/db";
import { fplClassicConfig, fplClassicEntrants, fplClassicEntryGws, fplClassicAwards } from "@/lib/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { monthLabel } from "./months";
import { buildAwardGroups, indexFrozenAwards, type ClassicAwardGroup } from "./award-groups";
import type { AwardContext } from "./awards";

export interface ClassicWinnersMonth {
  key: string;
  label: string;
  gws: number[];
  isComplete: boolean;
}

export interface ClassicWinnersPayload {
  league: {
    slug: string;
    name: string;
    season: string;
    fplLeagueId: number;
    fplLeagueName: string | null;
    scoringMetric: "net" | "gross";
    winnerCutPercent: number;
  };
  /** Awards are computed from data settled up to here, and no further. */
  settledThroughGw: number;
  entrantCount: number;
  months: ClassicWinnersMonth[];
  awards: ClassicAwardGroup[];
}

export async function buildClassicWinnersPayload(opts: {
  leagueId: string;
  leagueSlug: string;
  leagueName: string;
  season: string;
}): Promise<ClassicWinnersPayload | null> {
  const [config] = await db
    .select()
    .from(fplClassicConfig)
    .where(eq(fplClassicConfig.leagueId, opts.leagueId))
    .limit(1);
  if (!config) return null;

  const entrants = await db
    .select()
    .from(fplClassicEntrants)
    .where(and(eq(fplClassicEntrants.leagueId, opts.leagueId), eq(fplClassicEntrants.isActive, true)));

  const settledRows = entrants.length > 0
    ? await db
        .select()
        .from(fplClassicEntryGws)
        .where(and(
          eq(fplClassicEntryGws.leagueId, opts.leagueId),
          inArray(fplClassicEntryGws.entrantId, entrants.map((e) => e.id)),
        ))
    : [];

  // Months come from each row's FROZEN monthKey, never recomputed from a deadline — a concluded
  // gameweek's month must not move because FPL rescheduled something. Same derivation as
  // standings.ts, so the two pages can never disagree about which month a gameweek belongs to.
  const monthKeyByGw = new Map<number, string>();
  for (const row of settledRows) {
    if (!monthKeyByGw.has(row.gw)) monthKeyByGw.set(row.gw, row.monthKey);
  }
  const gwsByMonth = new Map<string, number[]>();
  for (const [gw, key] of monthKeyByGw) {
    const list = gwsByMonth.get(key) ?? [];
    list.push(gw);
    gwsByMonth.set(key, list);
  }
  const settledThroughGw = config.settledThroughGw;
  const months: ClassicWinnersMonth[] = [...gwsByMonth.entries()]
    .map(([key, gws]) => ({
      key,
      label: monthLabel(key),
      gws: [...gws].sort((a, b) => a - b),
      isComplete: gws.every((g) => g <= settledThroughGw),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const awardCtx: AwardContext = {
    entrants: entrants.map((e) => ({ id: e.id, playerName: e.playerName, entryName: e.entryName, firstSeenGw: e.firstSeenGw })),
    rows: settledRows.map((r) => ({
      entrantId: r.entrantId, gw: r.gw, points: r.points,
      netPoints: r.netPoints, benchPoints: r.benchPoints, monthKey: r.monthKey,
    })),
    months: months.map((m) => ({ key: m.key, label: m.label, gws: m.gws })),
    startGameweek: config.startGameweek,
    settledThroughGw,
    metric: config.scoringMetric as "net" | "gross",
    winnerCutPercent: config.winnerCutPercent,
  };

  const frozenAwardRows = settledThroughGw > 0
    ? await db.select().from(fplClassicAwards).where(eq(fplClassicAwards.leagueId, opts.leagueId))
    : [];

  const awards = buildAwardGroups(
    awardCtx,
    indexFrozenAwards(frozenAwardRows),
    new Map(entrants.map((e) => [e.id, { entryName: e.entryName, playerName: e.playerName }])),
    // The one difference from the standings page: undecided awards are included, as `leading`.
    { includeLeading: true },
  );

  return {
    league: {
      slug: opts.leagueSlug,
      name: opts.leagueName,
      season: opts.season,
      fplLeagueId: config.fplLeagueId,
      fplLeagueName: config.fplLeagueName,
      scoringMetric: config.scoringMetric as "net" | "gross",
      winnerCutPercent: config.winnerCutPercent,
    },
    settledThroughGw,
    entrantCount: entrants.length,
    months,
    awards,
  };
}
