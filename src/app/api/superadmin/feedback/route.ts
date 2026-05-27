import { NextRequest, NextResponse } from "next/server";
import { db, feedback } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";

/**
 * GET /api/superadmin/feedback
 * Returns site-scoped feedback rows (general platform feedback). Superadmin only.
 */
export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const rows = await db
      .select()
      .from(feedback)
      .where(eq(feedback.scope, "site"))
      .orderBy(desc(feedback.createdAt));

    return NextResponse.json({ feedback: rows });
  } catch (err) {
    console.error("Superadmin feedback GET error:", err);
    return NextResponse.json({ error: "Failed to fetch feedback" }, { status: 500 });
  }
}
