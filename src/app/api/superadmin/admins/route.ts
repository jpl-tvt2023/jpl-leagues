import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users, leagueAdmins } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";
import bcrypt from "bcryptjs";

export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const adminRows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      mustChangePassword: users.mustChangePassword,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(inArray(users.role, ["admin", "superadmin"]))
    .orderBy(users.createdAt);

  // Include league assignments for each admin
  const adminIds = adminRows.map((a) => a.id);
  const assignments =
    adminIds.length > 0
      ? await db
          .select({ userId: leagueAdmins.userId, leagueId: leagueAdmins.leagueId })
          .from(leagueAdmins)
          .where(inArray(leagueAdmins.userId, adminIds))
      : [];

  const assignmentMap: Record<string, string[]> = {};
  for (const a of assignments) {
    if (!assignmentMap[a.userId]) assignmentMap[a.userId] = [];
    assignmentMap[a.userId].push(a.leagueId);
  }

  const admins = adminRows.map((a) => ({
    ...a,
    assignedLeagueIds: assignmentMap[a.id] ?? [],
  }));

  return NextResponse.json({ admins });
}

/**
 * POST /api/superadmin/admins
 * Create a new admin user (mustChangePassword: true by default)
 */
export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { name, email, password } = body;

  if (!name || !email || !password) {
    return NextResponse.json({ error: "name, email, and password are required" }, { status: 400 });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const hashedPassword = await bcrypt.hash(password, 12);
  const id = generateId();

  try {
    await db.insert(users).values({
      id,
      name,
      email: normalizedEmail,
      password: hashedPassword,
      role: "admin",
      mustChangePassword: true,
    });

    return NextResponse.json({
      success: true,
      id,
      name,
      email: normalizedEmail,
      role: "admin",
      mustChangePassword: true,
      assignedLeagueIds: [],
    });
  } catch {
    return NextResponse.json({ error: "An admin with that email already exists" }, { status: 409 });
  }
}
