import { NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE_NAME, isSuperAdmin } from "@/lib/auth";
import { fetchAllPLClubsWithTiers } from "@/lib/formats/auction/club-auction";

/**
 * GET /api/auction/club-tiers?leagueId=xxx
 *
 * Returns every PL club with its resolved tier, so the "Nominate a Club" modal and Nomination
 * Order table can show tier + scoring perks without the client needing standings-config access
 * (that's superadmin-only elsewhere). Tier assignment is global, not per-league; `leagueId` is
 * required only for auth-pattern consistency with the rest of this API folder.
 *
 * Response: { clubs: [{ id, name, short, tier: "top8" | "mid" | "promoted" | null }] }
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;
  const isAdmin = isSuperAdmin(request);

  if (!session && !isAdmin) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const leagueId = request.nextUrl.searchParams.get("leagueId");
  if (!leagueId) {
    return NextResponse.json({ error: "leagueId is required" }, { status: 400 });
  }

  const clubs = await fetchAllPLClubsWithTiers();
  return NextResponse.json({ clubs });
}
