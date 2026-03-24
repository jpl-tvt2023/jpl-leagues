import { NextRequest, NextResponse } from "next/server";
import { db, users } from "@/lib/db";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";

/**
 * POST /api/admin/reset-season
 * Reset all season data — requires admin password confirmation
 */
export async function POST(request: NextRequest) {
  try {
    const sessionType = request.headers.get("x-session-type");
    const sessionId = request.headers.get("x-session-id");
    if (sessionType !== "admin" || !sessionId) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    // Look up admin user for password verification
    const admin = await db.query.users.findFirst({ where: eq(users.id, sessionId) });
    if (admin?.role !== "admin" && admin?.role !== "superadmin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { password } = body;

    if (!password) {
      return NextResponse.json({ error: "Password is required" }, { status: 400 });
    }

    // Verify admin password
    const isValid = await bcrypt.compare(password, admin.password);
    if (!isValid) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 403 });
    }

    // Delete in correct order (respecting foreign key constraints) within a transaction
    await db.transaction(async (tx) => {
      await tx.run(sql`DELETE FROM challenger_survival_entries`);
      await tx.run(sql`DELETE FROM audit_logs`);
      await tx.run(sql`DELETE FROM gameweek_chips`);
      await tx.run(sql`DELETE FROM gameweek_captains`);
      await tx.run(sql`DELETE FROM results`);
      await tx.run(sql`DELETE FROM fixtures`);
      await tx.run(sql`DELETE FROM playoff_ties`);
      await tx.run(sql`DELETE FROM players`);
      await tx.run(sql`DELETE FROM teams`);
      await tx.run(sql`DELETE FROM gameweeks`);
    });
    // Preserved: users (admin accounts), groups (A/B), settings (toggles)

    return NextResponse.json({
      success: true,
      message: "Season data has been reset. Admin accounts, groups, and settings are preserved.",
      deleted: [
        "teams", "players", "gameweeks", "fixtures", "results",
        "gameweek_captains", "gameweek_chips", "playoff_ties",
        "challenger_survival_entries", "audit_logs"
      ],
      preserved: ["users", "groups", "settings"]
    });
  } catch (error) {
    console.error("Error resetting season:", error);
    return NextResponse.json({ error: "Failed to reset season" }, { status: 500 });
  }
}
