import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { users, leagueAdmins } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";
import bcrypt from "bcryptjs";

/**
 * PATCH /api/superadmin/admins/[userId]
 * Edit an admin user — name, email, or reset password (sets mustChangePassword: true)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { userId } = await params;
  const body = await request.json();

  // Guard: a superadmin may only mutate their OWN superadmin row; mutating
  // another superadmin's credentials is forbidden (prevents lockout / role-escalation
  // between platform owners). Non-superadmin (admin) rows fall through.
  const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (target.role === "superadmin") {
    const callerId = request.headers.get("x-session-id");
    if (target.id !== callerId) {
      return NextResponse.json(
        { error: "Cannot modify another superadmin's account" },
        { status: 403 }
      );
    }
  }

  const updates: {
    name?: string;
    email?: string;
    password?: string;
    mustChangePassword?: boolean;
    updatedAt?: Date;
  } = {};

  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }
  if (typeof body.email === "string" && body.email.trim()) {
    // Match POST handler's normalization so signin (which compares case-insensitively
    // via stored-lowercase) and the unique-email index see a consistent value.
    updates.email = body.email.trim().toLowerCase();
  }
  if (typeof body.password === "string" && body.password) {
    updates.password = await bcrypt.hash(body.password, 12);
    updates.mustChangePassword = true;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  updates.updatedAt = new Date();

  try {
    await db.update(users).set(updates).where(eq(users.id, userId));
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Email already in use by another admin" }, { status: 409 });
  }
}

/**
 * DELETE /api/superadmin/admins/[userId]
 * Delete an admin user and all their league assignments
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { userId } = await params;

  // Prevent deleting superadmin accounts via this route
  const target = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (target.role === "superadmin") {
    return NextResponse.json({ error: "Cannot delete a superadmin account" }, { status: 403 });
  }

  await db.transaction(async (tx) => {
    await tx.delete(leagueAdmins).where(eq(leagueAdmins.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });

  return NextResponse.json({ success: true });
}
