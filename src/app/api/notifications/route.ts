import { NextRequest, NextResponse } from "next/server";
import { db, notifications } from "@/lib/db";
import { and, eq, desc, isNull, inArray } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";

/**
 * GET /api/notifications?leagueId=xxx
 * Returns recent notifications for the signed-in team (last 30 + all unread).
 */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session || session.type !== "team") {
    return NextResponse.json({ notifications: [], unreadCount: 0 });
  }

  const leagueId = request.nextUrl.searchParams.get("leagueId");
  const limitParam = parseInt(request.nextUrl.searchParams.get("limit") ?? "30", 10);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitParam) ? limitParam : 30));
  const where = leagueId
    ? and(eq(notifications.teamId, session.id), eq(notifications.leagueId, leagueId))
    : eq(notifications.teamId, session.id);

  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt))
    .limit(limit);

  const unreadCount = rows.filter((r) => r.readAt === null).length;

  return NextResponse.json({
    notifications: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    unreadCount,
  });
}

/**
 * PATCH /api/notifications
 * Body: { ids?: string[], all?: boolean }
 * Marks the specified notifications (or all unread ones for the team) as read.
 */
export async function PATCH(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySession(token) : null;

  if (!session || session.type !== "team") {
    return NextResponse.json({ error: "Team authentication required" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { ids, all } = body as { ids?: string[]; all?: boolean };

  const now = new Date();

  if (all) {
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(and(eq(notifications.teamId, session.id), isNull(notifications.readAt)));
  } else if (Array.isArray(ids) && ids.length > 0) {
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(and(eq(notifications.teamId, session.id), inArray(notifications.id, ids)));
  } else {
    return NextResponse.json({ error: "Provide ids[] or all:true" }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
