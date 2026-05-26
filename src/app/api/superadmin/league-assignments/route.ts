import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagueAdmins, users, leagues } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";

/**
 * POST /api/superadmin/league-assignments
 * Assign an admin to a league
 * Body: { userId, leagueId }
 */
export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { userId, leagueId } = body;

  if (!userId || !leagueId) {
    return NextResponse.json({ error: "userId and leagueId are required" }, { status: 400 });
  }

  // Verify user exists and is an admin (not superadmin — they have global access)
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (user.role !== "admin") {
    return NextResponse.json({ error: "League assignments only apply to admin users" }, { status: 400 });
  }

  // Verify league exists
  const league = await db.query.leagues.findFirst({ where: eq(leagues.id, leagueId) });
  if (!league) {
    return NextResponse.json({ error: "League not found" }, { status: 404 });
  }

  try {
    const id = generateId();
    await db.insert(leagueAdmins).values({ id, userId, leagueId });
    return NextResponse.json({ success: true, id, userId, leagueId });
  } catch {
    return NextResponse.json({ error: "This admin is already assigned to that league" }, { status: 409 });
  }
}

/**
 * DELETE /api/superadmin/league-assignments
 * Revoke an admin's access to a league
 * Body: { userId, leagueId }
 */
export async function DELETE(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { userId, leagueId } = body;

  if (!userId || !leagueId) {
    return NextResponse.json({ error: "userId and leagueId are required" }, { status: 400 });
  }

  // Look up the assignment first so we can return 404 if it doesn't exist —
  // otherwise a stale UI clicking 'remove' on an already-removed assignment
  // gets a green response and the operator never realises the row was gone.
  const existing = await db
    .select({ id: leagueAdmins.id })
    .from(leagueAdmins)
    .where(and(eq(leagueAdmins.userId, userId), eq(leagueAdmins.leagueId, leagueId)))
    .limit(1);
  if (existing.length === 0) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }

  await db
    .delete(leagueAdmins)
    .where(and(eq(leagueAdmins.userId, userId), eq(leagueAdmins.leagueId, leagueId)));

  return NextResponse.json({ success: true });
}
