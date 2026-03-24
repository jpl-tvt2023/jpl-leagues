import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isSuperAdmin } from "@/lib/auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const { id } = await params;
  const body = await request.json();

  const updates: { name?: string; season?: string; isActive?: boolean } = {};
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.season === "string") updates.season = body.season;
  if (typeof body.isActive === "boolean") updates.isActive = body.isActive;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  await db.update(leagues).set(updates).where(eq(leagues.id, id));
  return NextResponse.json({ success: true });
}
