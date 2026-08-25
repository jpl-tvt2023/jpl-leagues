/**
 * The league-stage standings computation — ONE implementation, six consumers.
 *
 * Every surface that asks "what rank is this team?" must come through here:
 * /api/standings, playoff seeding, the dashboard's group tables and rank badge,
 * Challenge-Chip / Double-Pointer eligibility, the Winners page, and cup-group seeding.
 *
 * Why it exists: the ranking rule had been re-implemented five more times, each copy
 * subtly different, and they disagreed on screen — the same team read #11 on the
 * dashboard and #14 on the standings page. The copies got these details wrong, so they
 * are the load-bearing parts of this file:
 *
 *   - W/D/L come from RAW FPL scores, never chip-adjusted match points. A Win-Win draw
 *     is a draw here even though it awards 2 points.
 *   - `leaguePoints` is DERIVED (wins*2 + draws + cbp - hitPenalty), never read from the
 *     stored `teams.leaguePoints` column. That column is an incrementally-mutated running
 *     total with no competition filter, no league-stage bound and no hit penalty, and it
 *     drifts whenever a result is edited.
 *   - Both fixture loops filter to the league stage AND to `competitionType` empty-or-"jpl",
 *     so Continental-Championship cup fixtures never leak into league points.
 *   - Ordering is `compareTiebreaker` (the published 5-tier rule) — see ./tvt/tiebreaker.ts.
 *
 * `throughGw` makes the whole thing historical: pass `gameweekNumber - 1` to get the table
 * as it stood before a gameweek, which is what chip eligibility is defined against.
 */

import { db, teams, gameweekChips, gameweeks, leagues, type Team, type Group, type Player, type Fixture, type Result, type Gameweek } from "@/lib/db";
import { eq, and, inArray } from "drizzle-orm";
import { getAllCachedScores, getCachedLeagueStageRows, setCachedLeagueStageRows } from "@/lib/fpl-cache";
import { calculateTeamGameweekScore } from "@/lib/fpl";
import { compareTiebreaker } from "@/lib/formats/tvt/tiebreaker";

type FixtureWithResult = Fixture & { result: Result | null; gameweek: Gameweek };
type TeamWithRelations = Team & {
  group: Group | null;
  players: Player[];
  homeFixtures: FixtureWithResult[];
  awayFixtures: FixtureWithResult[];
};

/** A chip row joined to its gameweek — what the CP/BP tooltip is built from. */
export type RawChip = Awaited<ReturnType<typeof db.query.gameweekChips.findMany>>[number] & {
  gameweek?: { number: number };
};

export interface LeagueStageRow {
  teamId: string;
  name: string;
  group: string | null;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  pointsDiff: number;
  /** Derived, not the stored column. */
  leaguePoints: number;
  /** The stored `teams.bonusPoints` ledger. Surfaced for API compatibility only —
   *  it is NOT a tiebreaker tier (it is a count of bonuses, not points). */
  bonusPoints: number;
  chipPoints: number;
  /** Chips + bonus — the value the CP/BP column renders and tier 4 compares. */
  cbpPoints: number;
  /** teamId -> match points earned against them. Tier 3. */
  headToHeadRecord: Record<string, number>;
  /** Tooltip ingredients, so consumers can render detail without recomputing. */
  bpsEntries: { gameweek: number; points: number }[];
  hitPenaltyGws: { gameweek: number; playerName: string; hits: number }[];
  hitPenaltyTotal: number;
  rawChips: RawChip[];
  players: { name: string; fplId: string; captaincyChipsUsed: number }[];
  /** 1-based rank within the team's own group, after the canonical sort. */
  groupRank: number;
  zone: "playoffs" | "challenger" | "eliminated";
}

export interface LeagueStageStandings {
  /** Every non-ghost team, globally sorted by `compareTiebreaker`. */
  rows: LeagueStageRow[];
  /** The same rows split by group name and re-ranked within each. */
  byGroup: Map<string, LeagueStageRow[]>;
  leagueStageEnd: number;
  throughGw: number;
  teamSize: number;
  leagueFormat: string;
  /** Highest league-stage gameweek with a result, bounded by `throughGw`. */
  maxPlayedGw: number;
}

/**
 * Which qualification band a rank falls in.
 *
 * Format-aware: an 8-team league has no rank 9..14, and its cutoff is the top 4.
 * The dashboard used to inline hardcoded 8/14 thresholds and got 8-team leagues wrong.
 */
export function getQualificationZone(rank: number, teamSize: number): "playoffs" | "challenger" | "eliminated" {
  if (teamSize === 8) {
    return rank <= 4 ? "playoffs" : "eliminated";
  }
  if (rank <= 8) return "playoffs";
  if (rank <= 14) return "challenger";
  return "eliminated";
}

/**
 * Split already-ranked rows by group name.
 *
 * Cup groups ("cup-...") are a different competition and never appear in the league
 * table. Groupless formats (8-team, 16-team, Continental Championship) are surfaced
 * under "A" so every consumer has one shape to read.
 *
 * Rank and zone are already stamped on each row by the time this runs — this only
 * partitions, which is why the cached path can call it without recomputing.
 */
function regroup(rows: LeagueStageRow[]): Map<string, LeagueStageRow[]> {
  const byGroup = new Map<string, LeagueStageRow[]>();
  const groupNames = [...new Set(
    rows.map((r) => r.group).filter((g): g is string => g !== null && !g.toLowerCase().startsWith("cup-")),
  )].sort();

  for (const gName of groupNames) {
    byGroup.set(gName, rows.filter((r) => r.group === gName));
  }
  if (groupNames.length === 0 && rows.length > 0) byGroup.set("A", rows);
  return byGroup;
}

/** A fixture counts toward league points only if it is in-window and not a cup tie. */
function countsForLeagueStage(f: FixtureWithResult, throughGw: number): boolean {
  if (f.gameweek.number > throughGw) return false;
  if (f.competitionType && f.competitionType !== "jpl") return false;
  return true;
}

/**
 * Per-GW, per-player transfer hits, for the -1 league point levied on any gameweek
 * where a player took more than 12 raw hits.
 *
 * Redis first. On a cold cache the FPL fetch is parallel WITHIN a gameweek and
 * sequential ACROSS gameweeks — the per-player sequential version this replaces made
 * ~1900 serial round-trips on a 32-team league and stalled for minutes.
 *
 * Best-effort: any failure yields no deductions rather than a failed request.
 */
async function loadPlayerGwHits(
  leagueId: string,
  allFplIds: Set<string>,
  processedGws: Set<number>,
): Promise<Map<string, Map<number, number>>> {
  const playerGwHitsMap = new Map<string, Map<number, number>>();
  const record = (fplId: string, gw: number, hits: number) => {
    if (!playerGwHitsMap.has(fplId)) playerGwHitsMap.set(fplId, new Map());
    playerGwHitsMap.get(fplId)!.set(gw, hits);
  };

  try {
    for (const gw of processedGws) {
      const gwCache = await getAllCachedScores(gw, leagueId);
      const suffix = `_gw${gw}`;
      if (Object.keys(gwCache).length > 0) {
        for (const [key, data] of Object.entries(gwCache)) {
          if (key.endsWith(suffix)) record(key.slice(0, -suffix.length), gw, data.transferHits);
        }
      } else {
        const fetched = await Promise.all(
          [...allFplIds].map(async (fplId) => {
            try {
              const score = await calculateTeamGameweekScore(fplId, gw, leagueId);
              return { fplId, hits: score.transferHits };
            } catch {
              return null;
            }
          }),
        );
        for (const r of fetched) {
          if (r) record(r.fplId, gw, r.hits);
        }
      }
    }
  } catch (e) {
    console.error("[standings] hit-penalty fetch failed (continuing without deductions):", e);
  }

  return playerGwHitsMap;
}

/**
 * Compute the ranked league-stage table for a league.
 *
 * @param leagueId  the league to rank
 * @param opts.throughGw  include gameweeks up to and including this number. Defaults to
 *   the league stage end (`playoffStartGw - 1`, or 38 for continental-championship).
 *   Pass `gameweekNumber - 1` for "the table as it stood before GW n", which is the
 *   basis chip eligibility is defined against.
 */
export async function computeLeagueStageStandings(
  leagueId: string,
  opts?: { throughGw?: number; skipCache?: boolean },
): Promise<LeagueStageStandings> {
  const leagueRows = await db
    .select({
      playoffStartGw: leagues.playoffStartGw,
      teamSize: leagues.teamSize,
      format: leagues.format,
    })
    .from(leagues)
    .where(eq(leagues.id, leagueId))
    .limit(1);

  const playoffStartGw = leagueRows[0]?.playoffStartGw ?? 31;
  const teamSize = leagueRows[0]?.teamSize ?? 32;
  const leagueFormat = leagueRows[0]?.format ?? "tvt";
  // Continental Championship runs the PL across all 38 GWs; TVT's league stage ends
  // the gameweek before the playoffs begin.
  const leagueStageEnd = leagueFormat === "continental-championship" ? 38 : playoffStartGw - 1;
  const throughGw = Math.min(opts?.throughGw ?? leagueStageEnd, leagueStageEnd);

  // The dashboard, chip eligibility and the standings page all land here on the same
  // request cycle, so serve a cached cut when one exists. `byGroup` is a Map and does
  // not survive JSON, so only `rows` is stored and the grouping is rebuilt below.
  if (!opts?.skipCache) {
    const cached = (await getCachedLeagueStageRows(leagueId, throughGw).catch(() => null)) as
      | { rows: LeagueStageRow[]; maxPlayedGw: number }
      | null;
    if (cached?.rows) {
      return {
        rows: cached.rows,
        byGroup: regroup(cached.rows),
        leagueStageEnd,
        throughGw,
        teamSize,
        leagueFormat,
        maxPlayedGw: cached.maxPlayedGw,
      };
    }
  }

  const allTeamsUnfiltered = (await db.query.teams.findMany({
    where: eq(teams.leagueId, leagueId),
    with: {
      group: true,
      players: true,
      homeFixtures: { with: { result: true, gameweek: true } },
      awayFixtures: { with: { result: true, gameweek: true } },
    },
  })) as TeamWithRelations[];

  // Ghost teams are bye placeholders for cup groups, not competitors.
  const allTeams = allTeamsUnfiltered.filter((t) => !t.isGhost);

  // ── Hit penalties ──
  // Skipped for continental-championship: its leaguePoints is stored directly by the
  // GW processor and is authoritative, so the FPL round-trips would buy nothing.
  const allFplIds = new Set<string>();
  for (const t of allTeams) {
    for (const p of t.players) allFplIds.add(p.fplId);
  }
  const processedGws = new Set<number>();
  if (leagueFormat !== "continental-championship") {
    for (const t of allTeams) {
      for (const f of [...t.homeFixtures, ...t.awayFixtures]) {
        if (f.result && countsForLeagueStage(f, throughGw)) processedGws.add(f.gameweek.number);
      }
    }
  }
  const playerGwHitsMap = await loadPlayerGwHits(leagueId, allFplIds, processedGws);

  // ── Chips ──
  // Scoped to THIS league's gameweeks. The copies this replaces queried the whole
  // gameweek_chips table unfiltered and relied on team ids not colliding.
  const leagueGwRows = await db
    .select({ id: gameweeks.id })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId));
  const leagueGwIds = leagueGwRows.map((g) => g.id);
  const allChipsRaw = (leagueGwIds.length === 0
    ? []
    : await db.query.gameweekChips.findMany({
        where: inArray(gameweekChips.gameweekId, leagueGwIds),
        with: { gameweek: true },
      })) as RawChip[];

  const chipPointsByTeam = new Map<string, number>();
  const teamChipsRawMap = new Map<string, RawChip[]>();
  for (const chip of allChipsRaw) {
    const chipGw = chip.gameweek?.number;
    if (chipGw && chipGw > throughGw) continue;
    if (chip.isProcessed) {
      const pts = chip.pointsAwarded || 0;
      // A Challenge Chip counts as played even when it awards 0.
      if (chip.chipType === "C" || pts > 0) {
        chipPointsByTeam.set(chip.teamId, (chipPointsByTeam.get(chip.teamId) || 0) + pts);
      }
    }
    const arr = teamChipsRawMap.get(chip.teamId) || [];
    arr.push(chip);
    teamChipsRawMap.set(chip.teamId, arr);
  }

  let maxPlayedGw = 0;

  // ── Rows ──
  const rows: LeagueStageRow[] = allTeams.map((team) => {
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let pointsFor = 0;
    let pointsAgainst = 0;
    let bonusPtsTotal = 0;
    const bpsEntries: { gameweek: number; points: number }[] = [];
    const headToHeadRecord: Record<string, number> = {};

    const consume = (f: FixtureWithResult, isHome: boolean) => {
      if (!countsForLeagueStage(f, throughGw)) return;
      if (!f.result) return;
      const own = isHome ? f.result.homeScore : f.result.awayScore;
      const opp = isHome ? f.result.awayScore : f.result.homeScore;
      const opponentId = isHome ? f.awayTeamId : f.homeTeamId;
      const gotBonus = isHome ? f.result.homeGotBonus : f.result.awayGotBonus;
      const usedDp = isHome ? f.result.homeUsedDoublePointer : f.result.awayUsedDoublePointer;

      if (f.gameweek.number > maxPlayedGw) maxPlayedGw = f.gameweek.number;
      pointsFor += own;
      pointsAgainst += opp;

      // Raw FPL scores decide W/D/L — deliberately NOT the chip-adjusted match points.
      let matchPts = 0;
      if (own > opp) { wins++; matchPts = 2; }
      else if (own === opp) { draws++; matchPts = 1; }
      else losses++;
      headToHeadRecord[opponentId] = (headToHeadRecord[opponentId] ?? 0) + matchPts;

      if (gotBonus) {
        const pts = usedDp ? 2 : 1;
        bonusPtsTotal += pts;
        bpsEntries.push({ gameweek: f.gameweek.number, points: pts });
      }
    };

    for (const f of team.homeFixtures) consume(f, true);
    for (const f of team.awayFixtures) consume(f, false);

    const played = wins + draws + losses;
    const chipPts = chipPointsByTeam.get(team.id) || 0;
    const cbpPts = chipPts + bonusPtsTotal;

    // -1 league point per GW in which any player on this team took more than 12 raw hits.
    const hitPenaltyGws: { gameweek: number; playerName: string; hits: number }[] = [];
    for (const player of team.players) {
      const gwHits = playerGwHitsMap.get(player.fplId);
      if (!gwHits) continue;
      for (const [gw, hits] of gwHits.entries()) {
        if (gw <= throughGw && hits > 12) {
          hitPenaltyGws.push({ gameweek: gw, playerName: player.name, hits });
        }
      }
    }
    hitPenaltyGws.sort((a, b) => a.gameweek - b.gameweek);
    const hitPenaltyTotal = hitPenaltyGws.length;

    // Continental Championship stores its own leaguePoints (PL-table points written by
    // processContinentalChampionshipGameweek); TVT derives from W/D/L + chips - hits.
    const leaguePoints = leagueFormat === "continental-championship"
      ? team.leaguePoints
      : (wins * 2) + (draws * 1) + cbpPts - hitPenaltyTotal;

    return {
      teamId: team.id,
      name: team.name,
      group: team.group?.name || null,
      played,
      wins,
      draws,
      losses,
      pointsFor,
      pointsAgainst,
      pointsDiff: pointsFor - pointsAgainst,
      leaguePoints,
      bonusPoints: team.bonusPoints,
      chipPoints: chipPts,
      cbpPoints: cbpPts,
      headToHeadRecord,
      bpsEntries: [...bpsEntries].sort((a, b) => a.gameweek - b.gameweek),
      hitPenaltyGws,
      hitPenaltyTotal,
      rawChips: teamChipsRawMap.get(team.id) || [],
      players: team.players.map((p) => ({
        name: p.name,
        fplId: p.fplId,
        captaincyChipsUsed: p.captaincyChipsUsed,
      })),
      groupRank: 0,
      zone: "eliminated",
    };
  });

  // The canonical order. Everything downstream is positional off this one sort.
  rows.sort(compareTiebreaker);

  // Stamp rank + zone per group, then partition. Rank is positional off the sort above.
  const byGroup = regroup(rows);
  for (const members of byGroup.values()) {
    members.forEach((row, i) => {
      row.groupRank = i + 1;
      row.zone = getQualificationZone(row.groupRank, teamSize);
    });
  }

  setCachedLeagueStageRows(leagueId, throughGw, { rows, maxPlayedGw }).catch(() => {});

  return { rows, byGroup, leagueStageEnd, throughGw, teamSize, leagueFormat, maxPlayedGw };
}
