import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { leagues } from "@/lib/db/schema";
import { isSuperAdmin } from "@/lib/auth";
import { generateId } from "@/lib/id";

export async function GET(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }
  const all = await db.select().from(leagues).orderBy(leagues.createdAt);
  return NextResponse.json({ leagues: all });
}

export async function POST(request: NextRequest) {
  if (!isSuperAdmin(request)) {
    return NextResponse.json({ error: "Superadmin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { slug, name, sport, format, season } = body;

  if (!slug || !name || !sport || !format || !season) {
    return NextResponse.json({ error: "slug, name, sport, format, and season are required" }, { status: 400 });
  }

  try {
    const id = generateId();
    await db.insert(leagues).values({ id, slug, name, sport, format, season, isActive: true });
    return NextResponse.json({ success: true, id, slug, name, sport, format, season, isActive: true });
  } catch {
    return NextResponse.json({ error: "League with that slug already exists" }, { status: 409 });
  }
}
