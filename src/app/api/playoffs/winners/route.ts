import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues, playoffTies, teams, players, gameweeks, fixtures, results } from "@/lib/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { computeLeagueStageStandings } from "@/lib/standings/league-stage";

/**
 * Hall of Champions — return the FULL position set for the league's format on
 * every request, with `pending: true` for positions whose underlying playoff
 * tie hasn't reached `status="complete"` yet. The page renders pending rows
 * as greyed-out "TBD — {placeholder}" entries so users see the bracket
 * structure from season start, with slots filling in as each round resolves.
 *
 * `concluded` flips to true only when every position is filled.
 */

interface Winner {
  position: number;
  label: string;
  category: "championship" | "challenger" | "jpl" | "jcl" | "jel" | "auction";
  pending: boolean;
  placeholder?: string;     // human-readable hint when pending (e.g. "Winner of 16T-FINAL")
  teamId: string | null;
  teamName: string | null;
  players: { name: string; fplId: string }[];
}

interface WinnersResponse {
  concluded: boolean;
  winners: Winner[];
}

export async function GET(req: NextRequest): Promise<NextResponse<WinnersResponse>> {
  try {
    const leagueSlug = req.nextUrl.searchParams.get("leagueSlug");
    if (!leagueSlug) {
      return NextResponse.json({ concluded: false, winners: [] }, { status: 400 });
    }

    const league = await db.query.leagues.findFirst({ where: eq(leagues.slug, leagueSlug) });
    if (!league) {
      return NextResponse.json({ concluded: false, winners: [] }, { status: 404 });
    }

    const leagueId = league.id;
    const teamSize = league.teamSize ?? 8;
    const format = league.format;

    let winnersData: Winner[];
    if (format === "continental-championship") {
      winnersData = await buildContinentalChampionshipWinners(leagueId);
    } else if (format === "auction") {
      winnersData = await buildAuctionWinner(leagueId);
    } else if (teamSize === 8) {
      winnersData = await build8TeamWinners(leagueId);
    } else if (teamSize === 16) {
      winnersData = await build16TeamWinners(leagueId);
    } else {
      winnersData = await build32TeamWinners(leagueId);
    }

    const concluded = winnersData.length > 0 && winnersData.every(w => !w.pending);
    return NextResponse.json({ concluded, winners: winnersData });
  } catch (error) {
    console.error("Winners API error:", error);
    return NextResponse.json({ concluded: false, winners: [] }, { status: 500 });
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Helpers                                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

type TieRef = {
  id: string;
  pos: number;
  label: string;
  category: Winner["category"];
  /** true = take the tie's winnerId; false = take the loserId. */
  winnerSide: boolean;
};

/**
 * Resolve a list of tie-driven positions. For each entry: if the tie is
 * `complete` and the relevant side has a teamId, return a filled row.
 * Otherwise return a pending row with a descriptive placeholder.
 */
async function resolveTiePositions(leagueId: string, refs: TieRef[]): Promise<Winner[]> {
  const out: Winner[] = [];
  for (const ref of refs) {
    const tie = await db.query.playoffTies.findFirst({
      where: and(eq(playoffTies.tieId, ref.id), eq(playoffTies.leagueId, leagueId)),
    });
    const teamId = tie?.status === "complete"
      ? (ref.winnerSide ? tie.winnerId : tie.loserId)
      : null;
    if (teamId) {
      const teamData = await getTeamData(teamId);
      if (teamData) {
        out.push({ position: ref.pos, label: ref.label, category: ref.category, pending: false, teamId: teamData.teamId, teamName: teamData.teamName, players: teamData.players });
        continue;
      }
    }
    out.push({
      position: ref.pos, label: ref.label, category: ref.category,
      pending: true,
      placeholder: `${ref.winnerSide ? "Winner" : "Loser"} of ${ref.id}`,
      teamId: null, teamName: null, players: [],
    });
  }
  return out;
}

async function getTeamData(teamId: string): Promise<Pick<Winner, "teamId" | "teamName" | "players"> | null> {
  const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
  if (!team) return null;
  const teamPlayers = await db.query.players.findMany({ where: eq(players.teamId, teamId) });
  return {
    teamId: team.id,
    teamName: team.name,
    players: teamPlayers.map((p) => ({ name: p.name, fplId: p.fplId })),
  };
}

/**
 * Check whether GW38 is fully scored (every fixture in GW38 has a result).
 * Used to gate season-long awards (PL Champion, Auction Season Champion) that
 * depend on standings being settled, not on a single tie.
 */
async function isGw38Settled(leagueId: string): Promise<boolean> {
  const [gw38] = await db.select({ id: gameweeks.id })
    .from(gameweeks)
    .where(and(eq(gameweeks.leagueId, leagueId), eq(gameweeks.number, 38)))
    .limit(1);
  if (!gw38) return false;

  const gwFixtures = await db.select({ id: fixtures.id }).from(fixtures).where(eq(fixtures.gameweekId, gw38.id));
  if (gwFixtures.length === 0) return false;

  const gwResults = await db.select({ fixtureId: results.fixtureId })
    .from(results)
    .where(inArray(results.fixtureId, gwFixtures.map(f => f.id)));
  return gwResults.length === gwFixtures.length;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/*  Per-format builders                                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

async function buildContinentalChampionshipWinners(leagueId: string): Promise<Winner[]> {
  const winners: Winner[] = [];

  // 1) PL Champion — rank 1 of the canonical table. Gated on GW38 being fully scored so
  // we don't crown mid-season leaders prematurely.
  //
  // This used to be `orderBy(desc(teams.leaguePoints)).limit(1)`: no tiebreaker at all,
  // over the stored column, so a level top two handed the trophy to whichever row the
  // database returned first.
  const settled = await isGw38Settled(leagueId);
  if (settled) {
    const { rows } = await computeLeagueStageStandings(leagueId);
    const teamData = rows.length > 0 ? await getTeamData(rows[0].teamId) : null;
    if (teamData) {
      winners.push({ position: 1, label: "JPL Champion", category: "jpl", pending: false, ...teamData });
    } else {
      winners.push(plPendingTC());
    }
  } else {
    winners.push(plPendingTC());
  }

  // 2) JCL Champion
  winners.push(...await resolveTiePositions(leagueId, [
    { id: "JCL-FINAL", pos: 2, label: "JCL Champion", category: "jcl", winnerSide: true },
  ]));

  // 3) JEL Champion
  winners.push(...await resolveTiePositions(leagueId, [
    { id: "JEL-FINAL", pos: 3, label: "JEL Champion", category: "jel", winnerSide: true },
  ]));

  return winners;
}

function plPendingTC(): Winner {
  return {
    position: 1, label: "JPL Champion", category: "jpl",
    pending: true, placeholder: "Top points after GW38",
    teamId: null, teamName: null, players: [],
  };
}

async function buildAuctionWinner(leagueId: string): Promise<Winner[]> {
  const settled = await isGw38Settled(leagueId);
  if (!settled) {
    return [{
      position: 1, label: "Season Champion", category: "auction",
      pending: true, placeholder: "To be crowned at season end",
      teamId: null, teamName: null, players: [],
    }];
  }
  const top = await db.select({ id: teams.id })
    .from(teams)
    .where(eq(teams.leagueId, leagueId))
    .orderBy(desc(teams.leaguePoints))
    .limit(1);
  const teamData = top.length > 0 ? await getTeamData(top[0].id) : null;
  if (!teamData) {
    return [{
      position: 1, label: "Season Champion", category: "auction",
      pending: true, placeholder: "To be crowned at season end",
      teamId: null, teamName: null, players: [],
    }];
  }
  return [{
    position: 1, label: "Season Champion", category: "auction",
    pending: false, ...teamData,
  }];
}

async function build8TeamWinners(leagueId: string): Promise<Winner[]> {
  return resolveTiePositions(leagueId, [
    { id: "8T-FINAL", pos: 1, label: "Champion",   category: "championship", winnerSide: true  },
    { id: "8T-FINAL", pos: 2, label: "Runner-Up",  category: "championship", winnerSide: false },
    { id: "8T-3RD",   pos: 3, label: "3rd Place",  category: "championship", winnerSide: true  },
  ]);
}

async function build16TeamWinners(leagueId: string): Promise<Winner[]> {
  return resolveTiePositions(leagueId, [
    { id: "16T-FINAL",  pos: 1, label: "Champion",                 category: "championship", winnerSide: true  },
    { id: "16T-FINAL",  pos: 2, label: "Runner-Up",                category: "championship", winnerSide: false },
    { id: "16T-CFINAL", pos: 3, label: "Challenger Champion",      category: "challenger",   winnerSide: true  },
    { id: "16T-CFINAL", pos: 4, label: "Challenger Runner-Up",     category: "challenger",   winnerSide: false },
    { id: "16T-C3RD",   pos: 5, label: "Challenger 3rd Place",     category: "challenger",   winnerSide: true  },
    { id: "16T-C3RD",   pos: 6, label: "Challenger 4th Place",     category: "challenger",   winnerSide: false },
  ]);
}

async function build32TeamWinners(leagueId: string): Promise<Winner[]> {
  return resolveTiePositions(leagueId, [
    { id: "Final",   pos:  1, label: "TVT Champion",            category: "championship", winnerSide: true  },
    { id: "Final",   pos:  2, label: "TVT Runner-Up",           category: "championship", winnerSide: false },
    { id: "C-38-A",  pos:  3, label: "Challenger Champion",     category: "challenger",   winnerSide: true  },
    { id: "C-38-A",  pos:  4, label: "Challenger Runner-Up",    category: "challenger",   winnerSide: false },
    { id: "C-37-A",  pos:  5, label: "Challenger SF (A)",       category: "challenger",   winnerSide: false },
    { id: "C-37-B",  pos:  6, label: "Challenger SF (B)",       category: "challenger",   winnerSide: false },
    { id: "C-36-A",  pos:  7, label: "Challenger QF (A)",       category: "challenger",   winnerSide: false },
    { id: "C-36-B",  pos:  8, label: "Challenger QF (B)",       category: "challenger",   winnerSide: false },
    { id: "C-35-A",  pos:  9, label: "Challenger R16 (A)",      category: "challenger",   winnerSide: false },
    { id: "C-35-B",  pos: 10, label: "Challenger R16 (B)",      category: "challenger",   winnerSide: false },
    { id: "C-35-C",  pos: 11, label: "Challenger R16 (C)",      category: "challenger",   winnerSide: false },
    { id: "C-35-D",  pos: 12, label: "Challenger R16 (D)",      category: "challenger",   winnerSide: false },
  ]);
}
