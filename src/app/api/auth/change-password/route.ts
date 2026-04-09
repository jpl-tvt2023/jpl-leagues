import { NextRequest, NextResponse } from "next/server";
import { db, users, teams } from "@/lib/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { currentPassword, newPassword } = body;

    // Verify session from signed cookie
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const session = token ? await verifySession(token) : null;
    if (!session) {
      return NextResponse.json(
        { error: "Not authenticated" },
        { status: 401 }
      );
    }

    const userId = (session.type === "admin" || session.type === "superadmin") ? session.id : null;
    const teamId = session.type === "team" ? session.id : null;

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: "Current password and new password are required" },
        { status: 400 }
      );
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: "New password must be at least 8 characters" },
        { status: 400 }
      );
    }

    if (!/[\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(newPassword)) {
      return NextResponse.json(
        { error: "New password must contain at least one number or special character" },
        { status: 400 }
      );
    }

    // Handle team password change
    if (teamId) {
      const teamList = await db.select().from(teams).where(eq(teams.id, teamId));
      const team = teamList[0];

      if (!team) {
        return NextResponse.json(
          { error: "Team not found" },
          { status: 404 }
        );
      }

      // Verify current password
      const isValid = await bcrypt.compare(currentPassword, team.password);
      if (!isValid) {
        return NextResponse.json(
          { error: "Current password is incorrect" },
          { status: 401 }
        );
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password and clear mustChangePassword flag
      await db.update(teams)
        .set({
          password: hashedPassword,
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(teams.id, teamId));

      // Re-fetch team to check isProfileComplete
      const updatedTeamList = await db.select().from(teams).where(eq(teams.id, teamId));
      const updatedTeam = updatedTeamList[0];

      return NextResponse.json({
        success: true,
        message: "Password changed successfully",
        redirectTo: updatedTeam.isProfileComplete ? "/" : "/setup",
      });
    }

    // Handle admin user password change
    if (userId) {
      const userList = await db.select().from(users).where(eq(users.id, userId));
      const user = userList[0];

      if (!user) {
        return NextResponse.json(
          { error: "User not found" },
          { status: 404 }
        );
      }

      // Verify current password
      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) {
        return NextResponse.json(
          { error: "Current password is incorrect" },
          { status: 401 }
        );
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password and clear mustChangePassword flag
      await db.update(users)
        .set({
          password: hashedPassword,
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      return NextResponse.json({
        success: true,
        message: "Password changed successfully",
        redirectTo: user.role === "superadmin" ? "/superadmin" : "/admin",
      });
    }

    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401 }
    );
  } catch (error) {
    console.error("Change password error:", error);
    return NextResponse.json(
      { error: "Failed to change password" },
      { status: 500 }
    );
  }
}
