/**
 * Everything the Match Center renders for one comparison: two JPL teams in one gameweek.
 *
 * The two teams need not be playing each other. The page opens on a fixture, but the reader
 * can compare any two teams in the league in any started gameweek, so every side is resolved on
 * its own — its own captain, its own stored score from its own fixture — and `fixture` is only
 * set when the pair genuinely met that gameweek.
 *
 * ## What is withheld before the deadline
 *
 * Captain announcements and TVT chip declarations are written before the deadline, and this
 * route is public. Until the deadline passes a side carries its roster and its FPL chip
 * history (public on the FPL site anyway) and nothing else — the same rule the fixtures route
 * applies to `chipsByGameweek`.
 *
 * ## Cost
 *
 * Picks come through the picks cache, which the live sweep fills for every manager, so a warm
 * Match Center makes no FPL calls at all. Cold, it is one picks fetch per manager plus the
 * shared live-elements, fixtures and bootstrap reads, all behind their own caches.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  fixtures,
  gameweekCaptains,
  gameweekChips,
  gameweeks,
  groups,
  leagues,
  players,
  results,
  teams,
} from "@/lib/db/schema";
import {
  fetchClubInfo,
  fetchElementGameweekDetail,
  fetchElementInfo,
  isGameweekFinal,
} from "@/lib/fpl";
import { getManagerPicks } from "@/lib/fpl-live/picks-cache";
import { getFplFixturesForGw } from "@/lib/fpl-live/players-left";
import { FplUnavailableError, withFplBudget } from "@/lib/fpl/gateway";
import type { FPLGameweekPicks } from "@/lib/fpl";
import { resolveFplChipStatuses } from "@/lib/fpl-league/chip-status-map";
import type { FplChipStatus } from "@/lib/fpl-league/chips";
import { chipCode, chipName } from "@/lib/formats/tvt/chip-labels";
import { isChipDisclosable, isChipWasted } from "@/lib/formats/tvt/chip-waste";
import { resolveJplCaptain } from "@/lib/scoring/jpl-captain";
import {
  buildTeamSheet,
  compareSheets,
  type ClubMeta,
  type ElementMeta,
  type SheetComparison,
  type SheetManagerInput,
  type TeamSheet,
} from "./team-sheet";

export const MATCH_CENTER_FORMATS = ["tvt", "continental-championship"] as const;

export interface MatchCenterTeamOption {
  id: string;
  name: string;
  /** TVT group letter, when the league has groups. */
  group: string | null;
  isGhost: boolean;
}

export interface MatchCenterSide {
  teamId: string;
  teamName: string;
  group: string | null;
  isGhost: boolean;
  roster: { playerId: string; name: string; fplId: string }[];
  /** This team's TVT chip this gameweek. Null before the deadline, always. */
  tvtChip: { code: string; name: string; isWasted: boolean; wastedReason: string | null } | null;
  /** FPL chip history per manager, cache-only. Absent = not known. */
  fplChips: Record<string, FplChipStatus>;
  /** Null before the deadline, for a ghost, or when FPL could not be reached. */
  sheet: TeamSheet | null;
  /** The team's processed score in its own fixture this gameweek, when there is one. */
  storedScore: number | null;
  /**
   * What the score line shows: the stored score once processed (authoritative — it includes
   * the carry-forward hit penalty), else the live sheet total.
   */
  displayTotal: number | null;
  /** storedScore − sheet.total, when both exist. Non-zero means the processor applied an adjustment. */
  adjustment: number;
  /** The team's own fixture this gameweek. */
  fixtureId: string | null;
}

export interface MatchCenterFixture {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  group: string | null;
  result: {
    homeScore: number;
    awayScore: number;
    homeGotBonus: boolean;
    awayGotBonus: boolean;
    homeUsedDoublePointer: boolean;
    awayUsedDoublePointer: boolean;
  } | null;
}

export interface MatchCenterPayload {
  leagueFormat: string;
  gameweek: { number: number; deadline: string; started: boolean; settled: boolean };
  /** Gameweeks the picker offers: every started one, plus the one requested. */
  gameweeks: number[];
  teams: MatchCenterTeamOption[];
  /** Set only when the two compared teams actually met in this gameweek. */
  fixture: MatchCenterFixture | null;
  a: MatchCenterSide;
  b: MatchCenterSide;
  comparison: SheetComparison | null;
  /** Why the sheets are missing after the deadline. */
  degraded: "fpl_unavailable" | null;
  generatedAt: string;
}

export class MatchCenterError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
  }
}

interface StoredPlayerScore {
  fplId?: string;
  isCaptain?: boolean;
  isTempCaptain?: boolean;
  isAutoAssigned?: boolean;
}

function parseStored(raw: string | null | undefined): StoredPlayerScore[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function loadMatchCenter(opts: {
  leagueSlug: string;
  fixtureId?: string | null;
  gw?: number | null;
  teamA?: string | null;
  teamB?: string | null;
  now?: Date;
}): Promise<MatchCenterPayload> {
  const now = opts.now ?? new Date();

  const [league] = await db
    .select({ id: leagues.id, format: leagues.format, enabledChips: leagues.enabledChips })
    .from(leagues)
    .where(eq(leagues.slug, opts.leagueSlug))
    .limit(1);
  if (!league) throw new MatchCenterError(404, "League not found");
  const format = league.format ?? "tvt";
  if (!(MATCH_CENTER_FORMATS as readonly string[]).includes(format)) {
    throw new MatchCenterError(404, "Match Center is not available for this league");
  }

  const gwRows = await db
    .select({ id: gameweeks.id, number: gameweeks.number, deadline: gameweeks.deadline })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, league.id));
  const gwByNumber = new Map(gwRows.map((g) => [g.number, g]));

  // Defaults from the fixture, overridden by whatever the reader picked.
  let gwNumber = opts.gw ?? null;
  let teamA = opts.teamA ?? null;
  let teamB = opts.teamB ?? null;
  if (opts.fixtureId) {
    const fx = await db.query.fixtures.findFirst({
      where: eq(fixtures.id, opts.fixtureId),
      with: { gameweek: true },
    });
    if (!fx || fx.gameweek.leagueId !== league.id) throw new MatchCenterError(404, "Fixture not found");
    gwNumber ??= fx.gameweek.number;
    teamA ??= fx.homeTeamId;
    teamB ??= fx.awayTeamId;
  }
  if (gwNumber == null || !teamA || !teamB) {
    throw new MatchCenterError(400, "A fixture, or a gameweek and two teams, is required");
  }
  const gw = gwByNumber.get(gwNumber);
  if (!gw) throw new MatchCenterError(404, `Gameweek ${gwNumber} not found`);
  const started = gw.deadline.getTime() <= now.getTime();

  // ── Teams ────────────────────────────────────────────────────────────
  const teamRows = await db
    .select({
      id: teams.id,
      name: teams.name,
      isGhost: teams.isGhost,
      groupName: groups.name,
      groupType: groups.groupType,
    })
    .from(teams)
    .leftJoin(groups, eq(teams.groupId, groups.id))
    .where(eq(teams.leagueId, league.id));
  // Group letters mean something only in TVT; Continental Championship's groups are cup groups.
  const groupOf = (t: (typeof teamRows)[number]) => (format === "tvt" ? t.groupName ?? null : null);
  const teamOptions: MatchCenterTeamOption[] = teamRows
    .map((t) => ({ id: t.id, name: t.name, group: groupOf(t), isGhost: t.isGhost }))
    .sort((x, y) => (x.group ?? "").localeCompare(y.group ?? "") || x.name.localeCompare(y.name));
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  if (!teamById.has(teamA) || !teamById.has(teamB)) throw new MatchCenterError(404, "Team not found");

  const rosterRows = await db
    .select({ id: players.id, name: players.name, fplId: players.fplId, teamId: players.teamId })
    .from(players)
    .where(inArray(players.teamId, [teamA, teamB]));
  const rosterOf = (teamId: string) =>
    rosterRows
      .filter((p) => p.teamId === teamId)
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((p) => ({ playerId: p.id, name: p.name, fplId: p.fplId }));

  // ── This gameweek's fixtures for either side (own scores, and whether they met) ─────────
  const gwFixtureRows = await db
    .select({
      id: fixtures.id,
      homeTeamId: fixtures.homeTeamId,
      awayTeamId: fixtures.awayTeamId,
      competitionType: fixtures.competitionType,
      groupName: groups.name,
      result: results,
    })
    .from(fixtures)
    .leftJoin(results, eq(results.fixtureId, fixtures.id))
    .leftJoin(groups, eq(fixtures.groupId, groups.id))
    .where(eq(fixtures.gameweekId, gw.id));
  // A Continental Championship gameweek also carries cup fixtures; a team's JPL score is its JPL one.
  const leagueFixtures = gwFixtureRows.filter((f) => !f.competitionType || f.competitionType === "jpl");
  const ownFixture = (teamId: string) =>
    leagueFixtures.find((f) => f.homeTeamId === teamId || f.awayTeamId === teamId) ?? null;
  const met = leagueFixtures.find(
    (f) =>
      (f.homeTeamId === teamA && f.awayTeamId === teamB) ||
      (f.homeTeamId === teamB && f.awayTeamId === teamA),
  );

  const fplChipMap = Object.fromEntries(
    await resolveFplChipStatuses(rosterRows.map((r) => r.fplId), {
      lane: "background",
      topUp: 0,
      label: "match center chips",
    }),
  );

  // ── TVT chips: past the deadline only ─────────────────────────────────
  const tvtChipByTeam = new Map<string, MatchCenterSide["tvtChip"]>();
  if (started && format === "tvt") {
    let enabled: string[] = ["D", "W", "C"];
    try { enabled = JSON.parse(league.enabledChips ?? '["D","W","C"]'); } catch { /* keep default */ }
    const chipRows = await db
      .select()
      .from(gameweekChips)
      .where(and(eq(gameweekChips.gameweekId, gw.id), inArray(gameweekChips.teamId, [teamA, teamB])));
    for (const c of chipRows) {
      if (!isChipDisclosable(c) || !enabled.includes(c.chipType)) continue;
      const wasted = isChipWasted(c);
      tvtChipByTeam.set(c.teamId, {
        code: chipCode(c.chipType),
        name: chipName(c.chipType),
        isWasted: wasted,
        wastedReason: wasted ? c.wastedReason ?? null : null,
      });
    }
  }

  // ── Sheets ───────────────────────────────────────────────────────────
  let settled = false;
  let degraded: MatchCenterPayload["degraded"] = null;
  const sheets = new Map<string, TeamSheet | null>();

  if (started) {
    try {
      await withFplBudget({ lane: "background", label: `match-center gw${gwNumber}`, max: 16 }, async () => {
        settled = await isGameweekFinal(gwNumber!, "background");
        const [detail, elementInfo, clubInfo, gwPlFixtures] = await Promise.all([
          fetchElementGameweekDetail(gwNumber!, "background"),
          fetchElementInfo("background"),
          fetchClubInfo("background"),
          getFplFixturesForGw(gwNumber!),
        ]);
        const elements = new Map<number, ElementMeta>(
          elementInfo.map((e) => [e.id, { id: e.id, name: e.web_name, position: e.element_type, clubId: e.team }]),
        );
        const clubs = new Map<number, ClubMeta>(
          clubInfo.map((c) => [c.id, { id: c.id, short: c.short_name, name: c.name }]),
        );

        const captains = await captainsFor(gw.id, gwNumber!, league.id, [teamA!, teamB!]);

        for (const teamId of [teamA!, teamB!]) {
          if (sheets.has(teamId)) continue;
          const team = teamById.get(teamId)!;
          if (team.isGhost) {
            sheets.set(teamId, null);
            continue;
          }
          const roster = rosterOf(teamId);
          const picksByFplId = new Map<string, FPLGameweekPicks | null>();
          for (const p of roster) {
            try {
              picksByFplId.set(p.fplId, await getManagerPicks(p.fplId, gwNumber!, { lane: "background", settled }));
            } catch (err) {
              if (err instanceof FplUnavailableError) throw err;
              picksByFplId.set(p.fplId, null);
            }
          }

          const managersFor = (captainId: string | null, isTemp: boolean): SheetManagerInput[] =>
            roster.map((p) => ({
              playerId: p.playerId,
              name: p.name,
              fplId: p.fplId,
              isJplCaptain: p.playerId === captainId,
              isTempCaptain: p.playerId === captainId && isTemp,
              picks: picksByFplId.get(p.fplId) ?? null,
            }));
          const build = (m: SheetManagerInput[]) =>
            buildTeamSheet({
              managers: m,
              settled,
              detail,
              elements,
              clubs,
              gwFixtures: gwPlFixtures,
              now: now.getTime(),
            });

          // Captain: what the processor stored, once there is a result; otherwise exactly what
          // the live fixture score uses (announced, else provisional lowest scorer).
          const own = ownFixture(teamId);
          const stored = own?.result
            ? parseStored(own.homeTeamId === teamId ? own.result.homePlayerScores : own.result.awayPlayerScores)
            : [];
          const storedCaptain = stored.find((s) => s.isCaptain);
          let captainId: string | null = null;
          let isTemp = false;
          if (storedCaptain?.fplId) {
            captainId = roster.find((p) => p.fplId === storedCaptain.fplId)?.playerId ?? null;
            isTemp = !!(storedCaptain.isTempCaptain || storedCaptain.isAutoAssigned);
          } else {
            const uncaptained = build(managersFor(null, false));
            const resolved = resolveJplCaptain(
              uncaptained.managers.filter((m) => !m.unavailable).map((m) => ({ id: m.playerId, name: m.name, netScore: m.net })),
              captains.announced.get(teamId),
              captains.autoAssigned.get(teamId) ?? false,
              captains.previous.get(teamId) ?? null,
            );
            captainId = resolved.captainId;
            isTemp = resolved.isTemp;
          }
          sheets.set(teamId, build(managersFor(captainId, isTemp)));
        }
      });
    } catch (err) {
      if (!(err instanceof FplUnavailableError)) throw err;
      degraded = "fpl_unavailable";
      sheets.clear();
    }
  }

  const sideFor = (teamId: string): MatchCenterSide => {
    const team = teamById.get(teamId)!;
    const own = ownFixture(teamId);
    const storedScore = own?.result
      ? own.homeTeamId === teamId ? own.result.homeScore : own.result.awayScore
      : null;
    const sheet = sheets.get(teamId) ?? null;
    return {
      teamId,
      teamName: team.name,
      group: groupOf(team),
      isGhost: team.isGhost,
      roster: rosterOf(teamId),
      tvtChip: started ? tvtChipByTeam.get(teamId) ?? null : null,
      fplChips: Object.fromEntries(
        rosterOf(teamId).filter((p) => fplChipMap[p.fplId]).map((p) => [p.fplId, fplChipMap[p.fplId]]),
      ),
      sheet,
      storedScore,
      displayTotal: storedScore ?? sheet?.total ?? null,
      adjustment: storedScore != null && sheet ? storedScore - sheet.total : 0,
      fixtureId: own?.id ?? null,
    };
  };

  const a = sideFor(teamA);
  const b = sideFor(teamB);

  const offered = new Set(gwRows.filter((g) => g.deadline.getTime() <= now.getTime()).map((g) => g.number));
  offered.add(gwNumber);

  return {
    leagueFormat: format,
    gameweek: { number: gwNumber, deadline: gw.deadline.toISOString(), started, settled },
    gameweeks: [...offered].sort((x, y) => x - y),
    teams: teamOptions,
    fixture: met
      ? {
          id: met.id,
          homeTeamId: met.homeTeamId,
          awayTeamId: met.awayTeamId,
          group: format === "tvt" ? met.groupName ?? null : null,
          result: met.result
            ? {
                homeScore: met.result.homeScore,
                awayScore: met.result.awayScore,
                homeGotBonus: met.result.homeGotBonus,
                awayGotBonus: met.result.awayGotBonus,
                homeUsedDoublePointer: met.result.homeUsedDoublePointer,
                awayUsedDoublePointer: met.result.awayUsedDoublePointer,
              }
            : null,
        }
      : null,
    a,
    b,
    comparison: a.sheet && b.sheet ? compareSheets(a.sheet, b.sheet) : null,
    degraded,
    generatedAt: now.toISOString(),
  };
}

/** Announced captains this gameweek, which of those were auto-assigned, and last week's. */
async function captainsFor(gameweekId: string, gwNumber: number, leagueId: string, teamIds: string[]) {
  const announced = new Map<string, string>();
  const autoAssigned = new Map<string, boolean>();
  const previous = new Map<string, string>();

  const rows = await db.query.gameweekCaptains.findMany({
    where: eq(gameweekCaptains.gameweekId, gameweekId),
    with: { player: true },
  });
  for (const r of rows) {
    if (!teamIds.includes(r.player.teamId)) continue;
    announced.set(r.player.teamId, r.player.id);
    autoAssigned.set(r.player.teamId, r.isValid === false);
  }

  if (gwNumber > 1) {
    const prevGw = await db.query.gameweeks.findFirst({
      where: and(eq(gameweeks.number, gwNumber - 1), eq(gameweeks.leagueId, leagueId)),
    });
    if (prevGw) {
      const prevRows = await db.query.gameweekCaptains.findMany({
        where: eq(gameweekCaptains.gameweekId, prevGw.id),
        with: { player: true },
      });
      for (const r of prevRows) {
        if (teamIds.includes(r.player.teamId)) previous.set(r.player.teamId, r.player.id);
      }
    }
  }
  return { announced, autoAssigned, previous };
}
