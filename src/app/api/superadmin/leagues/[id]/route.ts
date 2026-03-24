import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";

const ALLOWED_KEYS = ["isActive", "name", "season"] as const;
type AllowedKey = typeof ALLOWED_KEYS[number];
type LeagueUpdate = Partial<Record<AllowedKey, string | boolean>>;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await request.json();

  const updates: LeagueUpdate = {};
  for (const key of ALLOWED_KEYS) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  await db.update(leagues).set(updates).where(eq(leagues.id, id));
  return NextResponse.json({ success: true });
}
