/**
 * TVT Playoff Seeding & Generation Logic
 * Handles bracket seeding for all TVT formats: 32-team, 16-team, 8-team
 */

import { db, gameweeks } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import { fetchBootstrapData } from "@/lib/fpl";
import { generateId } from "@/lib/id";
import { computeLeagueStageStandings, type LeagueStageRow } from "@/lib/standings/league-stage";

// ============================================
// Seeding tables — 32-team (cross-group)
// ============================================

export const RO16_SEEDING: [string, string, number, string, number][] = [
  ["RO16-A", "A", 1, "B", 8],
  ["RO16-B", "B", 1, "A", 8],
  ["RO16-C", "A", 2, "B", 7],
  ["RO16-D", "B", 2, "A", 7],
  ["RO16-E", "A", 3, "B", 6],
  ["RO16-F", "B", 3, "A", 6],
  ["RO16-G", "A", 4, "B", 5],
  ["RO16-H", "B", 4, "A", 5],
];

export const C31_SEEDING_32: [string, string, number, string, number][] = [
  ["C-31-A", "A", 9,  "B", 14],
  ["C-31-B", "A", 10, "B", 13],
  ["C-31-C", "A", 11, "B", 12],
  ["C-31-D", "A", 12, "B", 11],
  ["C-31-E", "A", 13, "B", 10],
  ["C-31-F", "A", 14, "B", 9],
];

// ============================================
// Seeding tables — 8-team (single group A)
// ============================================

export const SF_SEEDING_8: [string, string, number, string, number][] = [
  ["8T-SF-A", "A", 1, "A", 4],
  ["8T-SF-B", "A", 2, "A", 3],
];

// ============================================
// 16-team playoff group stage schedule
// ============================================

export type GSMatch16 = [string, number, number, number]; // [tieId, gwOffset, homeIdx, awayIdx]

export const CHAMP_GA_MATCHES: GSMatch16[] = [
  ["16T-CA-31-1", 0, 0, 3], // GW31: rank1 v rank8
  ["16T-CA-31-2", 0, 1, 2], // GW31: rank4 v rank5
  ["16T-CA-32-1", 1, 0, 2], // GW32: rank1 v rank5
  ["16T-CA-32-2", 1, 1, 3], // GW32: rank4 v rank8
  ["16T-CA-33-1", 2, 0, 1], // GW33: rank1 v rank4  ("Group Final")
  ["16T-CA-33-2", 2, 2, 3], // GW33: rank5 v rank8
];

export const CHAMP_GB_MATCHES: GSMatch16[] = [
  ["16T-CB-31-1", 0, 0, 3], // GW31: rank2 v rank7
  ["16T-CB-31-2", 0, 1, 2], // GW31: rank3 v rank6
  ["16T-CB-32-1", 1, 0, 2], // GW32: rank2 v rank6
  ["16T-CB-32-2", 1, 1, 3], // GW32: rank3 v rank7
  ["16T-CB-33-1", 2, 0, 1], // GW33: rank2 v rank3  ("Group Final")
  ["16T-CB-33-2", 2, 2, 3], // GW33: rank6 v rank7
];

export const CHALL_GA_MATCHES: GSMatch16[] = [
  ["16T-XA-31-1", 0, 0, 3], // GW31: rank9  v rank16
  ["16T-XA-31-2", 0, 1, 2], // GW31: rank12 v rank13
  ["16T-XA-32-1", 1, 0, 2], // GW32: rank9  v rank13
  ["16T-XA-32-2", 1, 1, 3], // GW32: rank12 v rank16
  ["16T-XA-33-1", 2, 0, 1], // GW33: rank9  v rank12
  ["16T-XA-33-2", 2, 2, 3], // GW33: rank13 v rank16
];

export const CHALL_GB_MATCHES: GSMatch16[] = [
  ["16T-XB-31-1", 0, 0, 3], // GW31: rank10 v rank15
  ["16T-XB-31-2", 0, 1, 2], // GW31: rank11 v rank14
  ["16T-XB-32-1", 1, 0, 2], // GW32: rank10 v rank14
  ["16T-XB-32-2", 1, 1, 3], // GW32: rank11 v rank15
  ["16T-XB-33-1", 2, 0, 1], // GW33: rank10 v rank11
  ["16T-XB-33-2", 2, 2, 3], // GW33: rank14 v rank15
];

// ============================================
// Reusable standings computation
// ============================================

export interface RankedTeam {
  teamId: string;
  name: string;
  group: string;
  groupRank: number;
  leaguePoints: number;
  wins: number;
  /** Match points earned vs each opponent — tier 3 of `compareTiebreaker`. */
  headToHeadRecord: Record<string, number>;
  pointsFor: number;
  cbpPoints: number;
}

/**
 * Ranked group standings for playoff seeding.
 *
 * A thin adapter over the canonical computation, so the bracket a league is seeded into
 * is built from exactly the table the standings page shows. The duplicate row-builder
 * this replaces had drifted: it queried every chip row in every league unfiltered, and
 * its cold-cache hit-penalty loop fetched each player serially (~1900 round-trips on a
 * 32-team league) instead of in parallel per gameweek.
 */
export async function getGroupStandings(leagueId: string, leagueStageEnd: number): Promise<{ groupA: RankedTeam[]; groupB: RankedTeam[] } | null> {
  try {
    const { byGroup } = await computeLeagueStageStandings(leagueId, { throughGw: leagueStageEnd });

    const toRanked = (rows: LeagueStageRow[], groupName: string): RankedTeam[] =>
      rows.map((r) => ({
        teamId: r.teamId,
        name: r.name,
        group: groupName,
        groupRank: r.groupRank,
        leaguePoints: r.leaguePoints,
        wins: r.wins,
        headToHeadRecord: r.headToHeadRecord,
        pointsFor: r.pointsFor,
        cbpPoints: r.cbpPoints,
      }));

    const groupA = toRanked(byGroup.get("A") ?? [], "A");
    const groupB = toRanked(byGroup.get("B") ?? [], "B");
    return { groupA, groupB };
  } catch (error) {
    console.error("Error computing group standings:", error);
    return null;
  }
}

/**
 * Auto-create playoff gameweeks with real FPL deadlines where available
 */
export async function ensurePlayoffGws(playoffStartGw: number, leagueId: string): Promise<Record<number, string>> {
  // Fetch real FPL deadlines (best-effort; fall back to evenly-spaced placeholders)
  const fplDeadlines: Record<number, Date> = {};
  try {
    const bootstrap = await fetchBootstrapData();
    for (const event of (bootstrap.events as { id: number; deadline_time: string }[])) {
      fplDeadlines[event.id] = new Date(event.deadline_time);
    }
  } catch { /* non-fatal */ }

  const gwCache: Record<number, string> = {};
  for (let gwNum = playoffStartGw; gwNum <= 38; gwNum++) {
    const existing = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, gwNum), eq(gameweeks.leagueId, leagueId)),
    });
    if (existing) {
      gwCache[gwNum] = existing.id;
    } else {
      const gwId = generateId();
      const deadline = fplDeadlines[gwNum] ?? (() => {
        const d = new Date();
        d.setDate(d.getDate() + 7 * (gwNum - playoffStartGw + 1));
        d.setHours(11, 0, 0, 0);
        return d;
      })();
      await db.insert(gameweeks).values({ id: gwId, number: gwNum, deadline, isPlayoffs: true, leagueId });
      gwCache[gwNum] = gwId;
    }
  }
  return gwCache;
}

/**
 * Get initial round names per TVT format (used to identify what to delete on re-generate)
 */
export function getInitialRoundNames(teamSize: number): string[] {
  return teamSize === 8  ? ["8T-SF"] :
         teamSize === 16 ? ["16T-CA", "16T-CB", "16T-XA", "16T-XB"] :
                          ["RO16", "C-31"];
}
