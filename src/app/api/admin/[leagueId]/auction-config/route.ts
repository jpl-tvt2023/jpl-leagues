import { NextRequest, NextResponse } from "next/server";
import { db, gameweeks, leagues, auctionScores } from "@/lib/db";
import { and, eq, lt } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";
import { invalidateLeaguePageCache } from "@/lib/fpl-cache";
import { parseReleaseCycleGws, validateReleaseCycleGws } from "@/lib/formats/auction/cycle";

/**
 * PATCH /api/admin/[leagueId]/auction-config
 *
 * The two per-league auction knobs that aren't fixed at creation:
 *   - startGameweek     — first gameweek the league scores. Locked once anything has
 *                         been scored, because gameweek rows below it get deleted and
 *                         existing auctionScores would be orphaned by the move.
 *   - releaseCycleGws   — gameweeks at which pending releases finalize. Editable at any
 *                         time: a boundary that has already been processed cannot be
 *                         retroactively un-processed, so a later edit is harmless.
 *
 * Lives here rather than on /api/superadmin/leagues/[id] so league admins can manage it
 * from their own dashboard — getAuthorizedLeagueId admits both admins and superadmin.
 */
export async function PATCH(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const { startGameweek, releaseCycleGws } = body ?? {};

    if (startGameweek === undefined && releaseCycleGws === undefined) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const leagueRow = await db
      .select({
        format: leagues.format,
        startGameweek: leagues.startGameweek,
        releaseCycleGws: leagues.releaseCycleGws,
      })
      .from(leagues)
      .where(eq(leagues.id, leagueId))
      .limit(1);

    if (leagueRow.length === 0) {
      return NextResponse.json({ error: "League not found" }, { status: 404 });
    }
    const league = leagueRow[0];

    // Both columns exist on every league but only ever mean anything for auction.
    // Refuse elsewhere so the TVT/Continental defaults can't be silently overwritten.
    if (league.format !== "auction") {
      return NextResponse.json(
        { error: "Auction config can only be updated on auction leagues" },
        { status: 400 }
      );
    }

    let nextStartGw = league.startGameweek;

    if (startGameweek !== undefined) {
      if (!Number.isInteger(startGameweek) || startGameweek < 1 || startGameweek > 38) {
        return NextResponse.json(
          { error: "startGameweek must be an integer between 1 and 38" },
          { status: 400 }
        );
      }

      // Moving the start would delete gameweek rows; any scored gameweek makes that
      // destructive. One row is enough to know.
      const scored = await db
        .select({ id: auctionScores.id })
        .from(auctionScores)
        .where(eq(auctionScores.leagueId, leagueId))
        .limit(1);
      if (scored.length > 0 && startGameweek !== league.startGameweek) {
        return NextResponse.json(
          { error: "Cannot change the starting gameweek after a gameweek has been scored" },
          { status: 409 }
        );
      }

      nextStartGw = startGameweek;
    }

    let nextCycleGws = parseReleaseCycleGws(league.releaseCycleGws);

    if (releaseCycleGws !== undefined) {
      const check = validateReleaseCycleGws(releaseCycleGws, nextStartGw);
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
      nextCycleGws = check.gws;
    } else if (nextCycleGws.some((gw) => gw < nextStartGw)) {
      // Silently trimming the list could leave a league with no boundary at all, so make
      // the admin choose rather than guessing on their behalf.
      return NextResponse.json(
        {
          error:
            `Release cycle gameweeks (${nextCycleGws.join(", ")}) fall before the new starting gameweek ` +
            `(GW${nextStartGw}). Send releaseCycleGws alongside startGameweek to set new boundaries.`,
        },
        { status: 400 }
      );
    }

    const startGwChanged = nextStartGw !== league.startGameweek;

    await db.transaction(async (tx) => {
      await tx
        .update(leagues)
        .set({ startGameweek: nextStartGw, releaseCycleGws: JSON.stringify(nextCycleGws) })
        .where(eq(leagues.id, leagueId));

      // Drop gameweeks the league no longer covers. Safe only under the no-scores guard
      // above — and auction leagues have no fixtures, captains, or chips, so nothing else
      // references these rows.
      if (startGwChanged) {
        await tx
          .delete(gameweeks)
          .where(and(eq(gameweeks.leagueId, leagueId), lt(gameweeks.number, nextStartGw)));
      }
    });

    await invalidateLeaguePageCache(leagueId);

    return NextResponse.json({
      success: true,
      startGameweek: nextStartGw,
      releaseCycleGws: nextCycleGws,
      // Newly in-range gameweeks aren't seeded here; the admin re-runs Create Gameweeks,
      // which is idempotent and pulls real FPL deadlines.
      needsGameweekSeeding: startGwChanged,
    });
  } catch (err) {
    console.error("[auction-config]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
