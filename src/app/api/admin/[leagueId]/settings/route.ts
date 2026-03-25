import { NextRequest, NextResponse } from "next/server";
import { db, settings } from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { getAuthorizedLeagueId } from "@/lib/league-auth";

/**
 * GET /api/admin/[leagueId]/settings
 * Get current settings for this league
 */
export async function GET(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const allSettings = await db.select().from(settings).where(eq(settings.leagueId, leagueId));
    const settingsMap: Record<string, string> = {};
    for (const s of allSettings) {
      settingsMap[s.key] = s.value;
    }

    return NextResponse.json({
      captainAnnouncementEnabled: settingsMap["captainAnnouncementEnabled"] !== "false",
      chipAnnouncementEnabled: settingsMap["chipAnnouncementEnabled"] !== "false",
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

/**
 * POST /api/admin/[leagueId]/settings
 * Update settings for this league
 */
export async function POST(request: NextRequest) {
  try {
    const leagueId = await getAuthorizedLeagueId(request);
    if (!leagueId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const { key, value } = body;

    if (!key || typeof value !== "boolean") {
      return NextResponse.json({ error: "key and boolean value are required" }, { status: 400 });
    }

    const allowedKeys = ["captainAnnouncementEnabled", "chipAnnouncementEnabled"];
    if (!allowedKeys.includes(key)) {
      return NextResponse.json({ error: "Invalid setting key" }, { status: 400 });
    }

    await db.insert(settings)
      .values({ key, leagueId, value: String(value), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [settings.key, settings.leagueId],
        set: { value: String(value), updatedAt: new Date() },
      });

    return NextResponse.json({ success: true, key, value });
  } catch (error) {
    console.error("Error updating setting:", error);
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 });
  }
}
