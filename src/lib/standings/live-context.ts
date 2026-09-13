/**
 * Everything `applyLiveFixtures` needs for one league, assembled from the database and the
 * live-score cache.
 *
 * Kept out of the overlay so that module stays pure and unit-testable, and out of the standings
 * route so the route stays readable.
 *
 * ## This never calls FPL
 *
 * Live scores are read **cache-only**. A whole gameweek is ~64 FPL calls, and the standings page
 * is not the right place to pay that: the fixtures tab polls every three minutes and fills the
 * same `live:gw{N}:{leagueId}` key, so by the time anyone looks at the table it is warm. A cache
 * miss simply means no overlay on this request, which renders as the settled table — the correct
 * thing to show when we do not know any better.
 *
 * Chip-clash resolution is cache-only for the same reason (`topUp: 0`), and unknown resolves to
 * "not wasted" — the same asymmetry the processor documents, since voiding a chip on missing data
 * costs real points while honouring one that should have been voided is correctable.
 */

import { db } from "@/lib/db";
import { fixtures, gameweeks, gameweekChips } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getLiveCachedScores } from "@/lib/fpl-cache";

import { resolveFplChipStatuses } from "@/lib/fpl-league/chip-status-map";
import { tvtChipWasteReasonFor } from "@/lib/formats/tvt/fpl-chip-clash";
import { chipName as tvtChipName } from "@/lib/formats/tvt/chip-labels";
import {
  computeGameweekAwards,
  type AwardChipInput,
  type AwardFixtureInput,
  type TeamAward,
} from "@/lib/formats/tvt/gameweek-awards";
import type { LiveFixtureLike } from "@/lib/standings/live-overlay";

export interface LiveStandingsContext {
  gameweek: number;
  /** Only fixtures with no result row — what the overlay is allowed to fold in. */
  fixtures: LiveFixtureLike[];
  awards: Map<string, TeamAward>;
  /** When the live scores were computed, for the freshness stamp. */
  cachedAt: string | null;
}

/** A team's managers, for resolving whether an FPL chip clash voided their TVT chip. */
export interface TeamPlayersRow {
  teamId: string;
  players: { fplId: string }[];
}

/**
 * Resolve the live overlay input for a league, or null when there is nothing to overlay.
 *
 * `gwNumber` is the in-flight gameweek, resolved by the caller because it also decides whether to
 * bypass the settled cache — one lookup, two uses.
 *
 * Null covers every "show the settled table" case: no live scores cached, or every fixture in the
 * gameweek already processed.
 */
export async function resolveLiveStandingsContext(
  leagueId: string,
  leagueFormat: string,
  gwNumber: number,
  teams: TeamPlayersRow[],
): Promise<LiveStandingsContext | null> {
  const cached = await getLiveCachedScores(gwNumber, leagueId);
  if (!cached?.fixtures?.length) return null;

  const [gwRow] = await db
    .select({ id: gameweeks.id })
    .from(gameweeks)
    .where(and(eq(gameweeks.number, gwNumber), eq(gameweeks.leagueId, leagueId)))
    .limit(1);
  if (!gwRow) return null;

  const gwFixtures = await db.query.fixtures.findMany({
    where: eq(fixtures.gameweekId, gwRow.id),
    with: { result: true },
  });
  if (gwFixtures.length === 0) return null;

  const liveByFixtureId = new Map(cached.fixtures.map((f) => [f.fixtureId, f]));

  // Only unprocessed fixtures are live. A processed one is already in the settled rows.
  const live: LiveFixtureLike[] = [];
  for (const fx of gwFixtures) {
    if (fx.result) continue;
    const scored = liveByFixtureId.get(fx.id);
    if (!scored) continue;
    live.push({
      fixtureId: fx.id,
      homeTeamId: fx.homeTeamId,
      awayTeamId: fx.awayTeamId,
      homeScore: scored.homeScore,
      awayScore: scored.awayScore,
      homePlayers: scored.homePlayers,
      awayPlayers: scored.awayPlayers,
    });
  }
  if (live.length === 0) return null;

  // Continental Championship scores nothing but the 2/1/0 ledger, so there is no point
  // resolving chips or margins for it — the overlay ignores them anyway.
  if (leagueFormat === "continental-championship") {
    return { gameweek: gwNumber, fixtures: live, awards: new Map(), cachedAt: cached.cachedAt ?? null };
  }

  // The bonus is the largest 75+ margin in a GROUP, so every fixture in the gameweek has to be
  // weighed — the ones still live and the ones already settled. Leaving the settled ones out
  // would hand the bonus to whichever live fixture happened to lead, even when a processed one
  // beat it.
  const awardFixtures: AwardFixtureInput[] = [];
  for (const fx of gwFixtures) {
    const scored = fx.result ? null : liveByFixtureId.get(fx.id);
    if (fx.result) {
      awardFixtures.push({
        fixtureId: fx.id,
        groupId: fx.groupId,
        homeTeamId: fx.homeTeamId,
        awayTeamId: fx.awayTeamId,
        homeScore: fx.result.homeScore,
        awayScore: fx.result.awayScore,
        homeHits: 0,
        awayHits: 0,
        homeUsedDoublePointer: fx.result.homeUsedDoublePointer,
        awayUsedDoublePointer: fx.result.awayUsedDoublePointer,
      });
    } else if (scored) {
      awardFixtures.push({
        fixtureId: fx.id,
        groupId: fx.groupId,
        homeTeamId: fx.homeTeamId,
        awayTeamId: fx.awayTeamId,
        homeScore: scored.homeScore,
        awayScore: scored.awayScore,
        homeHits: sumHits(scored.homePlayers),
        awayHits: sumHits(scored.awayPlayers),
      });
    }
  }

  const chips = await resolveChips(gwRow.id, gwNumber, teams, awardFixtures);
  const { byTeam } = computeGameweekAwards({ fixtures: awardFixtures, chips });

  return { gameweek: gwNumber, fixtures: live, awards: byTeam, cachedAt: cached.cachedAt ?? null };
}

function sumHits(players?: { transferHits: number }[]): number {
  if (!players) return 0;
  let total = 0;
  for (const p of players) total += p.transferHits;
  return total;
}

/**
 * The gameweek's declared chips, with each one's clash verdict.
 *
 * A chip already processed keeps the verdict stored against it — that decision is made and must
 * not be re-litigated from a cache that may have moved. An undecided one is resolved from cached
 * FPL histories only.
 */
async function resolveChips(
  gameweekId: string,
  gwNumber: number,
  teams: TeamPlayersRow[],
  awardFixtures: AwardFixtureInput[],
): Promise<AwardChipInput[]> {
  const rows = await db
    .select()
    .from(gameweekChips)
    .where(and(eq(gameweekChips.gameweekId, gameweekId), eq(gameweekChips.isValid, true)));
  if (rows.length === 0) return [];

  // Only teams actually playing in this gameweek can earn anything from a chip.
  const playing = new Set<string>();
  for (const fx of awardFixtures) {
    playing.add(fx.homeTeamId);
    playing.add(fx.awayTeamId);
  }
  const relevant = rows.filter((c) => playing.has(c.teamId));
  if (relevant.length === 0) return [];

  const playersByTeam = new Map(teams.map((t) => [t.teamId, t.players]));
  const fplIds = relevant.flatMap((c) => (playersByTeam.get(c.teamId) ?? []).map((p) => p.fplId));

  // topUp: 0 — reads the cached histories and fetches nothing.
  const statuses = await resolveFplChipStatuses(fplIds, {
    lane: "background",
    topUp: 0,
    label: "standings live chips",
  });

  return relevant.map((chip) => {
    let wastedReason = chip.wastedReason ?? null;
    if (!chip.isProcessed) {
      const teamStatuses = (playersByTeam.get(chip.teamId) ?? []).map(
        (p) => statuses.get(p.fplId) ?? null,
      );
      wastedReason = tvtChipWasteReasonFor(teamStatuses, gwNumber, tvtChipName(chip.chipType));
    }
    return {
      chipId: chip.id,
      teamId: chip.teamId,
      chipType: chip.chipType,
      wastedReason,
    };
  });
}
