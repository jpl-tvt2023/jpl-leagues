import { NextRequest, NextResponse } from "next/server";
import { db, users, teams } from "@/lib/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createSession, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { identifier, password } = body;

    if (!identifier || !password) {
      return NextResponse.json(
        { error: "Login ID and password are required" },
        { status: 400 }
      );
    }

    // Check if it's an admin login (contains @)
    const isEmailLogin = identifier.includes("@");

    if (isEmailLogin) {
      // Admin login via email
      const userList = await db.select().from(users).where(eq(users.email, identifier.toLowerCase()));
      const user = userList[0];

      if (!user) {
        return NextResponse.json(
          { error: "Invalid credentials" },
          { status: 401 }
        );
      }

      // Verify password
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        return NextResponse.json(
          { error: "Invalid credentials" },
          { status: 401 }
        );
      }

      const response = NextResponse.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          isAdmin: true, // backward compat
          mustChangePassword: user.mustChangePassword,
        },
        redirectTo: user.mustChangePassword ? "/change-password" : user.role === "superadmin" ? "/superadmin" : "/admin",
      });

      // Session type matches the user's role ("superadmin" or "admin")
      const token = await createSession(user.id, user.role as "superadmin" | "admin");
      response.cookies.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);

      return response;
    } else {
      // Team login via team login ID
      const teamList = await db.select().from(teams).where(eq(teams.teamLoginId, identifier));
      const team = teamList[0];

      if (!team) {
        return NextResponse.json(
          { error: "Invalid credentials" },
          { status: 401 }
        );
      }

      // Verify password
      const isValid = await bcrypt.compare(password, team.password);
      if (!isValid) {
        return NextResponse.json(
          { error: "Invalid credentials" },
          { status: 401 }
        );
      }

      // Determine redirect: password change → setup wizard → dashboard.
      // Single source of truth; the signin client trusts this value directly (no local override).
      let redirectTo = "/dashboard";
      if (team.mustChangePassword) {
        redirectTo = "/change-password";
      } else if (!team.isProfileComplete) {
        redirectTo = "/setup";
      }

      const response = NextResponse.json({
        success: true,
        team: {
          id: team.id,
          name: team.name,
          groupId: team.groupId,
          isAdmin: false,
          mustChangePassword: team.mustChangePassword,
          isProfileComplete: team.isProfileComplete,
        },
        redirectTo,
      });

      // Single signed session cookie — replaces teamId/isAdmin cookies
      const token = await createSession(team.id, "team");
      response.cookies.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);

      return response;
    }
  } catch (error) {
    console.error("Sign in error:", error);
    return NextResponse.json(
      { error: "Sign in failed" },
      { status: 500 }
    );
  }
}
