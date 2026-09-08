/**
 * Team-level stats for the FPL League page.
 *
 * The page's own builder (./standings.ts) answers "how is each MANAGER doing in official
 * FPL?" — this answers "what has each TEAM spent?": which of the league's TVT chips are
 * still available in each set, and how many captaincies each of its two managers has used.
 *
 * Kept out of `buildFplLeagueStandings` on purpose. That function's whole contract is the
 * FPL call budget and the warm/cache protocol, and `tests/league-types/redis-paths.spec.ts`
 * pins its zero-outbound-call steady state. Everything here is plain DB reads; keeping them
 * beside it rather than inside it makes "no new FPL calls" obvious at review time.
 *
 * DISCLOSURE: /api/fpl-league is public (src/middleware.ts). A `gameweek_chips` row exists
 * from the moment a chip is DECLARED, well before its deadline — surfacing it early would
 * tell the league what a team is about to play. Everything here goes through the same
 * deadline gate /api/standings uses, and withholding happens server-side: a hidden value is
 * never sent, because anyone can read the JSON.
 */

import { and, count, eq, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  gameweekCaptains,
  gameweekChips,
  gameweeks,
  groups,
  players,
  settings,
  teams,
} from "@/lib/db/schema";
import { computeCaptainCap, computeCaptainCheckLimit } from "@/lib/captains";
import { CONTINENTAL_FORMAT } from "@/lib/format-palette";
import { getChipSet } from "@/lib/formats/tvt/chip-set";
import {
  computeTeamChipSlots,
  type DisclosableChipInput,
  type TeamChipSlot,
} from "./team-chip-slots";

export type { TeamChipSlot, DisclosableChipInput };

export interface TeamCaptainCount {
  /** The key. `players.fplId` has no unique constraint, so it cannot be one. */
  playerId: string;
  playerName: string;
  fplId: string;
  /** Captaincies taken: gameweek_captains rows past their deadline, within the League Stage. */
  used: number;
  /** computeCaptainCap() — 15 for a default TVT league, 19 for Continental Championship. */
  cap: number;
}

export interface FplLeagueTeam {
  teamId: string;
  teamName: string;
  /** Resolved JPL group. null when ungrouped, cup-typed, or groups are not revealed yet. */
  group: string | null;
  /** null when the format has no TVT chips (Continental Championship) — client hides them. */
  chips: TeamChipSlot[] | null;
  /** 0..2 entries. Do NOT assume exactly 2: a team's setup can be incomplete. */
  captains: TeamCaptainCount[];
}

export interface FplLeagueTeamStats {
  /** Alphabetical by team name. The client partitions this by `group`. */
  teams: FplLeagueTeam[];
  /** Distinct non-cup group names, ascending. Empty when ungrouped or unrevealed. */
  groupNames: string[];
  groupsRevealed: boolean;
  /** The league HAS more than one group but is withholding it — drives the banner. */
  hasHiddenGroups: boolean;
  /** False for Continental Championship and auction. */
  chipsSupported: boolean;
  /** Which chip set the header gameweek falls in, so the client can emphasise it. */
  currentSet: 1 | 2 | "playoffs" | null;
}

/**
 * What the route serves when this module is skipped (auction) or fails. The client renders
 * its original flat table on an empty `teams`, so a failure here costs the stats, not the page.
 */
export const EMPTY_TEAM_STATS: FplLeagueTeamStats = {
  teams: [],
  groupNames: [],
  groupsRevealed: false,
  hasHiddenGroups: false,
  chipsSupported: false,
  currentSet: null,
};

const DEFAULT_ENABLED_CHIPS = ["D", "W", "C"];

/**
 * Is this a real JPL group?
 *
 * Continental Championship reassigns `teams.groupId` to its CUP groups once those are
 * generated, so an unfiltered join splits a CC league into Cup-A…Cup-D. Both checks, because
 * `groupType` is nullable and `regroup()` in lib/standings/league-stage.ts goes by the name
 * prefix — matching it exactly is what keeps this page and the standings page agreeing.
 */
function jplGroupName(name: string | null, groupType: string | null): string | null {
  if (name == null) return null;
  if ((groupType ?? "jpl") === "cup") return null;
  if (name.toLowerCase().startsWith("cup-")) return null;
  return name;
}

function parseEnabledChips(json: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(json ?? JSON.stringify(DEFAULT_ENABLED_CHIPS));
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_ENABLED_CHIPS;
  } catch {
    return DEFAULT_ENABLED_CHIPS; // malformed config must degrade, never 500
  }
}

export async function buildFplLeagueTeamStats(opts: {
  leagueId: string;
  format: string;
  playoffStartGw: number | null;
  enabledChipsJson: string | null;
  /** The gameweek the page's table is showing, already resolved by buildFplLeagueStandings. */
  headerGw: number | null;
}): Promise<FplLeagueTeamStats> {
  const { leagueId, format, headerGw } = opts;

  // Auction teams have no `players` rows at all — the two-manager roster is a TVT/CC concept
  // created by team setup. Short-circuit so that page renders byte-identically to before.
  if (format === "auction") return EMPTY_TEAM_STATS;

  // Continental Championship has no TVT chips (its standings hide CP/BP for the same reason).
  const chipsSupported = format !== CONTINENTAL_FORMAT;
  const playoffStartGw = opts.playoffStartGw ?? 31;
  const enabledChips = parseEnabledChips(opts.enabledChipsJson);
  const captainCheckLimit = computeCaptainCheckLimit(format, playoffStartGw);
  const cap = computeCaptainCap(format, playoffStartGw);
  const now = new Date();

  const [teamRows, gwRows, playerRows, captainRows, revealedRows] = await Promise.all([
    db
      .select({
        id: teams.id,
        name: teams.name,
        groupName: groups.name,
        groupType: groups.groupType,
      })
      .from(teams)
      .leftJoin(groups, eq(teams.groupId, groups.id))
      // Continental Championship seeds Ghost teams that carry a group but no players; without
      // this they render as empty team header rows with nothing underneath.
      .where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false))),

    // Read fresh every request. Deadlines move, and baking a time-dependent verdict into a
    // cache is what once hid the fixtures page's chips for a whole TTL.
    db
      .select({ id: gameweeks.id, number: gameweeks.number, deadline: gameweeks.deadline })
      .from(gameweeks)
      .where(eq(gameweeks.leagueId, leagueId)),

    db
      .select({
        id: players.id,
        name: players.name,
        fplId: players.fplId,
        teamId: players.teamId,
      })
      .from(players)
      .innerJoin(teams, eq(players.teamId, teams.id))
      .where(eq(teams.leagueId, leagueId)),

    // Aggregated in SQL: a 32-team 30-gameweek league is ~960 rows, and this runs on every one
    // of up to 30 warm polls per visitor. The GROUP BY returns at most one row per player.
    //
    // Counted from gameweek_captains, NOT players.captaincyChipsUsed — that column is written
    // only by the scorer's auto-fallback and the admin CSV import, so an ordinary captaincy via
    // POST /api/team/captain never touches it and it under-counts.
    db
      .select({ playerId: gameweekCaptains.playerId, used: count() })
      .from(gameweekCaptains)
      .innerJoin(gameweeks, eq(gameweekCaptains.gameweekId, gameweeks.id))
      .innerJoin(players, eq(gameweekCaptains.playerId, players.id))
      .innerJoin(teams, eq(players.teamId, teams.id))
      .where(
        and(
          eq(teams.leagueId, leagueId),
          lte(gameweeks.number, captainCheckLimit),
          // The disclosure gate, in SQL: a captain announced for a still-open gameweek is not
          // public. This is why the number here can read one lower than what that team sees on
          // its own dashboard mid-gameweek — the dashboard counts its own pending pick, which
          // is correct for a private quota and wrong for a public page.
          lte(gameweeks.deadline, now),
        ),
      )
      .groupBy(gameweekCaptains.playerId),

    db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.leagueId, leagueId), eq(settings.key, "groupsRevealed"))),
  ]);

  const chipRows = chipsSupported
    ? await db
        .select({
          teamId: gameweekChips.teamId,
          gameweekId: gameweekChips.gameweekId,
          chipType: gameweekChips.chipType,
          isValid: gameweekChips.isValid,
          isProcessed: gameweekChips.isProcessed,
          // Both of these feed isChipWasted. Selecting only isValid/isProcessed would silently
          // misreport waste for the two other representations it recognises.
          hadNegativeHits: gameweekChips.hadNegativeHits,
          wastedReason: gameweekChips.wastedReason,
        })
        .from(gameweekChips)
        .innerJoin(gameweeks, eq(gameweekChips.gameweekId, gameweeks.id))
        .where(eq(gameweeks.leagueId, leagueId))
    : [];

  const gwById = new Map(gwRows.map((g) => [g.id, g]));
  const nowMs = now.getTime();

  const chipsByTeam = new Map<string, DisclosableChipInput[]>();
  for (const row of chipRows) {
    const gw = gwById.get(row.gameweekId);
    if (!gw) continue;
    const list = chipsByTeam.get(row.teamId) ?? [];
    list.push({
      chipType: row.chipType,
      gameweekNumber: gw.number,
      deadlineMs: gw.deadline.getTime(),
      isValid: row.isValid,
      isProcessed: row.isProcessed,
      hadNegativeHits: row.hadNegativeHits,
      wastedReason: row.wastedReason,
    });
    chipsByTeam.set(row.teamId, list);
  }

  const captainCountByPlayer = new Map(captainRows.map((r) => [r.playerId, Number(r.used)]));
  const playersByTeam = new Map<string, typeof playerRows>();
  for (const p of [...playerRows].sort((a, b) => a.name.localeCompare(b.name))) {
    const list = playersByTeam.get(p.teamId) ?? [];
    list.push(p);
    playersByTeam.set(p.teamId, list);
  }

  const groupsRevealed = revealedRows[0]?.value === "true";
  const realGroupNames = [
    ...new Set(
      teamRows
        .map((t) => jplGroupName(t.groupName, t.groupType))
        .filter((g): g is string => g !== null),
    ),
  ].sort();
  // The league has groups worth splitting on, but the admin has not announced them.
  const hasHiddenGroups = !groupsRevealed && realGroupNames.length > 1;

  const built: FplLeagueTeam[] = teamRows
    .map((t) => ({
      teamId: t.id,
      teamName: t.name,
      // Withheld server-side, not just hidden in the UI: this route is public, so a group
      // name in the payload is a group name anyone can read.
      group: hasHiddenGroups ? null : jplGroupName(t.groupName, t.groupType),
      chips: chipsSupported
        ? computeTeamChipSlots(chipsByTeam.get(t.id) ?? [], enabledChips, playoffStartGw, nowMs)
        : null,
      captains: (playersByTeam.get(t.id) ?? []).map((p) => ({
        playerId: p.id,
        playerName: p.name,
        fplId: p.fplId,
        used: captainCountByPlayer.get(p.id) ?? 0,
        cap,
      })),
    }))
    .sort((a, b) => a.teamName.localeCompare(b.teamName));

  return {
    teams: built,
    groupNames: hasHiddenGroups ? [] : realGroupNames,
    groupsRevealed,
    hasHiddenGroups,
    chipsSupported,
    // Derived from the header gameweek the standings builder already resolved. Deliberately
    // NOT getCurrentGameweekNumber(), which reaches the FPL gateway — redis-paths.spec.ts
    // pins this route's zero-outbound-call steady state.
    currentSet: headerGw == null ? null : getChipSet(headerGw, playoffStartGw),
  };
}
