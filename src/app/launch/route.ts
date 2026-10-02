import { NextResponse, type NextRequest } from "next/server";
import { resolveViewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";

/**
 * The installed app's `start_url` (see `src/app/manifest.ts`).
 *
 * Tapping the home-screen icon should land a signed-in user on their own dashboard, not on the
 * public league list — so this resolves the session and redirects. Signed-out (or FPL Classic
 * viewers, who have no accounts) go to the league list.
 */
export async function GET(request: NextRequest) {
  const viewer = await resolveViewer();
  const target = viewer.authenticated ? viewer.dashboardHref : "/";
  return NextResponse.redirect(new URL(target, request.url), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
