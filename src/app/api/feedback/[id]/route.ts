import { NextRequest, NextResponse } from "next/server";
import { db, feedback, leagueAdmins, leagues } from "@/lib/db";
import { eq, and } from "drizzle-orm";

const MAX_RESOLUTION_NOTE_LENGTH = 500;

/**
 * Authorise a mutation on a given feedback row. Site-scoped rows require
 * superadmin; league-scoped rows require admin of that league OR superadmin.
 * Returns the row when authorised, or a NextResponse with the right error
 * status when not.
 */
async function loadAndAuthorise(
  request: NextRequest,
  feedbackId: string
): Promise<typeof feedback.$inferSelect | NextResponse> {
  const sessionType = request.headers.get("x-session-type");
  const sessionId = request.headers.get("x-session-id");

  if (!sessionType || !sessionId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (sessionType !== "admin" && sessionType !== "superadmin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await db.select().from(feedback).where(eq(feedback.id, feedbackId)).limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: "Feedback not found" }, { status: 404 });
  }
  const row = rows[0];

  if (sessionType === "superadmin") {
    return row;
  }

  // admin
  if (row.scope === "site") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!row.leagueId) {
    return NextResponse.json({ error: "Feedback has no league" }, { status: 400 });
  }
  const adminRow = await db
    .select({ id: leagueAdmins.id })
    .from(leagueAdmins)
    .where(and(eq(leagueAdmins.userId, sessionId), eq(leagueAdmins.leagueId, row.leagueId)))
    .limit(1);
  if (adminRow.length === 0) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Block inactive leagues for admins (parity with getAuthorizedLeagueId)
  const league = await db
    .select({ isActive: leagues.isActive })
    .from(leagues)
    .where(eq(leagues.id, row.leagueId))
    .limit(1);
  if (!league[0]?.isActive) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return row;
}

interface RouteContext { params: Promise<{ id: string }> }

/**
 * PATCH /api/feedback/[id]
 * Body: { action: "toggle-important" | "toggle-resolved"; resolutionNote?: string }
 * - toggle-important flips the isImportant flag.
 * - toggle-resolved: if currently null → sets resolvedAt + optional resolutionNote;
 *   if currently set → clears both (un-resolves).
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const result = await loadAndAuthorise(request, id);
    if (result instanceof NextResponse) return result;
    const row = result;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const { action, resolutionNote } = body as { action?: unknown; resolutionNote?: unknown };

    if (action !== "toggle-important" && action !== "toggle-resolved") {
      return NextResponse.json(
        { error: "action must be 'toggle-important' or 'toggle-resolved'" },
        { status: 400 }
      );
    }

    const now = new Date();
    if (action === "toggle-important") {
      await db
        .update(feedback)
        .set({ isImportant: !row.isImportant, updatedAt: now })
        .where(eq(feedback.id, id));
      return NextResponse.json({ success: true, isImportant: !row.isImportant });
    }

    // toggle-resolved
    if (row.resolvedAt) {
      await db
        .update(feedback)
        .set({ resolvedAt: null, resolutionNote: null, updatedAt: now })
        .where(eq(feedback.id, id));
      return NextResponse.json({ success: true, resolvedAt: null });
    }

    let note: string | null = null;
    if (resolutionNote !== undefined && resolutionNote !== null && resolutionNote !== "") {
      if (typeof resolutionNote !== "string") {
        return NextResponse.json({ error: "resolutionNote must be a string" }, { status: 400 });
      }
      const trimmed = resolutionNote.trim();
      if (trimmed.length > MAX_RESOLUTION_NOTE_LENGTH) {
        return NextResponse.json(
          { error: `resolutionNote must be ${MAX_RESOLUTION_NOTE_LENGTH} characters or fewer` },
          { status: 400 }
        );
      }
      note = trimmed.length > 0 ? trimmed : null;
    }

    await db
      .update(feedback)
      .set({ resolvedAt: now, resolutionNote: note, updatedAt: now })
      .where(eq(feedback.id, id));
    return NextResponse.json({ success: true, resolvedAt: now.toISOString(), resolutionNote: note });
  } catch (err) {
    console.error("Feedback PATCH error:", err);
    return NextResponse.json({ error: "Failed to update feedback" }, { status: 500 });
  }
}

/**
 * DELETE /api/feedback/[id]
 * Hard-deletes the row. Same access-control as PATCH.
 */
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const result = await loadAndAuthorise(request, id);
    if (result instanceof NextResponse) return result;

    await db.delete(feedback).where(eq(feedback.id, id));
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Feedback DELETE error:", err);
    return NextResponse.json({ error: "Failed to delete feedback" }, { status: 500 });
  }
}
