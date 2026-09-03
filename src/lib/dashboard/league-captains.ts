/**
 * The dashboard's league-wide "Captains & Chips" card, for one gameweek.
 *
 * Extracted from api/team/dashboard/route.ts so the standalone captains route can serve any
 * gameweek the navigator asks for without the two builders drifting apart — the card's shape is
 * load-bearing (chip codes, the Challenge Chip's rebuilt match, the own-team-first sort) and two
 * copies of it would disagree within a release or two.
 *
 * ⚠️ DISCLOSURE. This payload has no deadline gate: a captain or chip is visible to the whole
 * league the moment it is announced, which is the league's own rule. That is only safe because
 * callers restrict WHICH gameweeks may be asked for. A chip can be declared well before its
 * gameweek's deadline, so serving an arbitrary future gameweek here would hand a team their
 * opponent's chip before that opponent had to commit. The caller owns that clamp — see
 * `resolveCaptainsWindow` — and this function deliberately does not second-guess it, because a
 * silent clamp in here would make the route's own 400 unreachable and untestable.
 */

import { db } from "@/lib/db";
import { teams, gameweekCaptains, gameweekChips, gameweeks } from "@/lib/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { chipCode, chipName } from "@/lib/formats/tvt/chip-labels";
import { buildChallengeMatches } from "@/lib/formats/tvt/challenge-match-query";
import type { ChallengeMatch } from "@/lib/formats/tvt/challenge-match";
import { getCurrentGameweekNumber } from "@/lib/gameweeks/current-gw";

export interface LeagueCaptainRow {
  teamId: string;
  teamName: string;
  groupName: string;
  isOwnTeam: boolean;
  captainPlayerName: string | null;
  announcedAt: string | null;
  /** Raw stored code ("D"). NOT for display — see `chipCode`. */
  chipType: string | null;
  /** Short pill code ("DP"). */
  chipCode: string | null;
  /** Full name for tooltips ("Double Pointer"). */
  chipName: string | null;
  /** Team the Challenge Chip targets. Null for every other chip. */
  challengedTeamId: string | null;
  /** That team's name, resolved here so the client can render it directly. */
  challengedTeamName: string | null;
  /**
   * The challenge match, rebuilt from both sides' own fixture results for the chip's gameweek.
   * Null until that gameweek is scored, so it is populated for past gameweeks and empty for the
   * current one.
   */
  challenge: ChallengeMatch | null;
}

export interface CaptainsWindow {
  /** The gameweek the card shows unless the reader picks another. */
  defaultGw: number;
  /** Every gameweek the reader may select, ascending. */
  availableGws: number[];
}

/**
 * Which gameweeks this league's card may show, and which one it lands on.
 *
 * The default is the lowest gameweek that has NOT concluded per FPL — so once GW3 finishes the
 * card moves to GW4, rather than waiting for our own scorer to write GW3's results. That is
 * `getCurrentGameweekNumber`; do not introduce a second notion of "current gameweek".
 *
 * The default is also the FORWARD EDGE of the range, not a midpoint. Everything before it is
 * already public; everything after it may contain undisclosed chip declarations.
 */
export async function resolveCaptainsWindow(leagueId: string): Promise<CaptainsWindow | null> {
  const rows = await db
    .select({ number: gameweeks.number })
    .from(gameweeks)
    .where(eq(gameweeks.leagueId, leagueId))
    .orderBy(asc(gameweeks.number));
  if (rows.length === 0) return null;

  const current = await getCurrentGameweekNumber(leagueId);
  const defaultGw = current ?? rows[0].number;

  return {
    defaultGw,
    availableGws: rows.map((r) => r.number).filter((n) => n <= defaultGw),
  };
}

/** Resolve a gameweek number to its row id for this league. */
export async function findGameweekId(leagueId: string, gwNumber: number): Promise<string | null> {
  const [row] = await db
    .select({ id: gameweeks.id })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), eq(gameweeks.number, gwNumber)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Every team's captain and chip for one gameweek.
 *
 * Queries are bounded by team count (≤32 per league), so this is a handful of small reads
 * regardless of which gameweek is asked for.
 */
export async function buildLeagueCaptains(opts: {
  leagueId: string;
  gameweekId: string;
  /** The viewing team, flagged so the card can pin it to the top. Null for a viewer with no team. */
  viewerTeamId: string | null;
  leagueFormat: string;
}): Promise<LeagueCaptainRow[]> {
  const { leagueId, gameweekId, viewerTeamId, leagueFormat } = opts;

  const allTeamsInLeague = await db.query.teams.findMany({
    where: eq(teams.leagueId, leagueId),
    with: { group: true },
  });
  if (allTeamsInLeague.length === 0) return [];

  const captainsForGw = await db.query.gameweekCaptains.findMany({
    where: eq(gameweekCaptains.gameweekId, gameweekId),
    with: { player: true },
  });
  const captainByTeam = new Map<string, { name: string; announcedAt: Date | null }>();
  for (const c of captainsForGw) {
    if (c.player?.teamId) {
      captainByTeam.set(c.player.teamId, {
        name: c.player.name,
        announcedAt: c.announcedAt ?? null,
      });
    }
  }

  // Chip announcements — only TVT has chips. Continental Championship skips the fetch entirely.
  // The Challenge Chip's target rides along so the card can name it.
  const chipByTeam = new Map<string, { chipType: string; challengedTeamId: string | null }>();
  const challengeByTeam = new Map<string, ChallengeMatch>();

  if (leagueFormat !== "continental-championship") {
    const chipsForGw = await db.query.gameweekChips.findMany({
      where: eq(gameweekChips.gameweekId, gameweekId),
    });
    for (const ch of chipsForGw) {
      if (ch.teamId && ch.chipType) {
        chipByTeam.set(ch.teamId, {
          chipType: ch.chipType,
          challengedTeamId: ch.challengedTeamId ?? null,
        });
      }
    }

    // Rebuild each Challenge Chip's match from the two teams' own results. Keyed off the chip's
    // OWN gameweek — which is this one — so navigating gameweeks moves the match with the card.
    const ccRows = chipsForGw.filter((c) => c.chipType === "C");
    if (ccRows.length > 0) {
      const matches = await buildChallengeMatches(
        ccRows.map((c) => ({
          id: c.id,
          teamId: c.teamId,
          challengedTeamId: c.challengedTeamId,
          gameweekId: c.gameweekId,
          pointsAwarded: c.pointsAwarded,
          isProcessed: c.isProcessed,
        })),
      );
      for (const c of ccRows) {
        const m = matches.get(c.id);
        if (m) challengeByTeam.set(c.teamId, m);
      }
    }
  }

  // `allTeamsInLeague` is already loaded, so resolving the challenged team's name costs nothing.
  const teamNameById = new Map(allTeamsInLeague.map((t) => [t.id, t.name]));

  const rows: LeagueCaptainRow[] = allTeamsInLeague.map((t) => {
    const picked = captainByTeam.get(t.id);
    const chip = chipByTeam.get(t.id) ?? null;
    const chipType = chip?.chipType ?? null;
    const challengedTeamId = chip?.challengedTeamId ?? null;
    return {
      teamId: t.id,
      teamName: t.name,
      groupName: t.group?.name ?? "",
      isOwnTeam: t.id === viewerTeamId,
      captainPlayerName: picked?.name ?? null,
      announcedAt: picked?.announcedAt ? picked.announcedAt.toISOString() : null,
      chipType,
      chipCode: chipType ? chipCode(chipType) : null,
      chipName: chipType ? chipName(chipType) : null,
      challengedTeamId,
      challengedTeamName: challengedTeamId ? teamNameById.get(challengedTeamId) ?? null : null,
      challenge: chipType === "C" ? challengeByTeam.get(t.id) ?? null : null,
    };
  });

  rows.sort((a, b) => {
    if (a.isOwnTeam !== b.isOwnTeam) return a.isOwnTeam ? -1 : 1;
    const g = a.groupName.localeCompare(b.groupName);
    if (g !== 0) return g;
    return a.teamName.localeCompare(b.teamName);
  });

  return rows;
}
