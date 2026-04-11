import { NextRequest, NextResponse } from "next/server";
import { db, teams } from "@/lib/db";
import { eq } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";

const EARLY_REDEMPTION_COST = 5_000_000; // £5M before GW 10
const LATE_REDEMPTION_COST = 3_000_000; // £3M after GW 10
const LATE_REDEMPTION_GW = 10;

/**
 * POST /api/auction/redeem-slot
 * Redeem a penalty slot by paying a fee from the team's purse.
 *
 * Body: { teamId, currentGw }
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session || session.type !== "team") {
    return NextResponse.json({ error: "Team authentication required" }, { status: 401 });
  }

  const body = await request.json();
  const { teamId, currentGw } = body;

  if (!teamId || typeof currentGw !== "number") {
    return NextResponse.json({ error: "teamId and currentGw are required" }, { status: 400 });
  }

  if (session.id !== teamId) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  const teamRow = await db
    .select({ purse: teams.purse, penaltySlots: teams.penaltySlots, totalSpent: teams.totalSpent })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);

  if (teamRow.length === 0) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  if (teamRow[0].penaltySlots <= 0) {
    return NextResponse.json({ error: "No penalty slots to redeem" }, { status: 400 });
  }

  const cost = currentGw >= LATE_REDEMPTION_GW ? LATE_REDEMPTION_COST : EARLY_REDEMPTION_COST;

  if (teamRow[0].purse < cost) {
    return NextResponse.json(
      { error: `Insufficient purse. Redemption costs £${(cost / 1_000_000).toFixed(0)}M` },
      { status: 400 }
    );
  }

  await db
    .update(teams)
    .set({
      penaltySlots: teamRow[0].penaltySlots - 1,
      purse: teamRow[0].purse - cost,
      totalSpent: teamRow[0].totalSpent + cost,
    })
    .where(eq(teams.id, teamId));

  return NextResponse.json({
    success: true,
    cost,
    remainingPenaltySlots: teamRow[0].penaltySlots - 1,
  });
}
