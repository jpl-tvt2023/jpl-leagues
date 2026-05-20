import { NextRequest, NextResponse } from "next/server";
import { db, users, teams, leagueAdmins, leagues } from "@/lib/db";
import { eq } from "drizzle-orm";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!token) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    const session = await verifySession(token);
    if (!session) {
      return NextResponse.json({ authenticated: false }, { status: 200 });
    }

    if (session.type === "admin" || session.type === "superadmin") {
      const userList = await db.select().from(users).where(eq(users.id, session.id));
      const user = userList[0];
      if (user) {
        let adminLeagueId: string | null = null;
        let leagueSlug: string | null = null;
        if (session.type === "admin") {
          const leagueRow = await db
            .select({ leagueId: leagueAdmins.leagueId, slug: leagues.slug })
            .from(leagueAdmins)
            .innerJoin(leagues, eq(leagueAdmins.leagueId, leagues.id))
            .where(eq(leagueAdmins.userId, user.id))
            .limit(2);
          adminLeagueId = leagueRow[0]?.leagueId ?? null;
          leagueSlug = leagueRow.length === 1 ? leagueRow[0].slug ?? null : null;
        }
        return NextResponse.json({
          authenticated: true,
          type: session.type,
          adminLeagueId,
          leagueSlug,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            isAdmin: true, // backward compat
          },
        });
      }
    }

    if (session.type === "team") {
      const teamList = await db.select().from(teams).where(eq(teams.id, session.id));
      const team = teamList[0];
      if (team) {
        // Fetch league format so the client knows which setup flow to use. Defensive: if the
        // auction_tier column lags its migration on the target DB, the SELECT throws and the outer
        // catch would (wrongly) sign the user out. Fall back to omitting the column and defaulting.
        let leagueFormat: string = "tvt";
        let leagueSlug: string | null = null;
        let clubAuctionEnabled = false;
        let auctionTier: "primary" | "complete" = "complete";
        try {
          const leagueRow = await db
            .select({ format: leagues.format, slug: leagues.slug, clubAuctionEnabled: leagues.clubAuctionEnabled, auctionTier: leagues.auctionTier })
            .from(leagues)
            .where(eq(leagues.id, team.leagueId))
            .limit(1);
          leagueFormat = leagueRow[0]?.format ?? "tvt";
          leagueSlug = leagueRow[0]?.slug ?? null;
          clubAuctionEnabled = leagueRow[0]?.clubAuctionEnabled ?? false;
          auctionTier = leagueRow[0]?.auctionTier ?? "complete";
        } catch (err) {
          console.warn("[auth/me] full league SELECT failed — retrying without auctionTier. Pending migration?", err);
          const leagueRow = await db
            .select({ format: leagues.format, slug: leagues.slug, clubAuctionEnabled: leagues.clubAuctionEnabled })
            .from(leagues)
            .where(eq(leagues.id, team.leagueId))
            .limit(1);
          leagueFormat = leagueRow[0]?.format ?? "tvt";
          leagueSlug = leagueRow[0]?.slug ?? null;
          clubAuctionEnabled = leagueRow[0]?.clubAuctionEnabled ?? false;
        }

        return NextResponse.json({
          authenticated: true,
          type: "team",
          leagueFormat,
          leagueSlug,
          clubAuctionEnabled,
          auctionTier,
          team: {
            id: team.id,
            name: team.name,
            groupId: team.groupId,
            mustChangePassword: team.mustChangePassword,
            isProfileComplete: team.isProfileComplete,
          },
        });
      }
    }

    return NextResponse.json({ authenticated: false }, { status: 200 });
  } catch (error) {
    console.error("Auth check error:", error);
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }
}
