import { NextRequest, NextResponse } from "next/server";
import { FPL_ALLOWED_PATH } from "@/lib/fpl-links";

/**
 * GET /go/fpl/entry/{id}/event/{n}  →  302 to the official FPL site.
 *
 * A best-effort hop for the Android app-link problem: some launchers do not
 * re-resolve a native app's intent filters across a redirect, so a click that
 * would have opened the Premier League app can land in the browser instead.
 * It is not a guarantee — see the note in components/FplEntryLink.tsx — and
 * links only route through here when NEXT_PUBLIC_FPL_LINK_HOP=1.
 *
 * The path allow-list is not optional. Redirecting to an arbitrary
 * caller-supplied URL is an open redirect: an attacker could send
 * /go/fpl/... links that look like ours and land on a phishing page.
 *
 * This is a page route (not under /api), so middleware ignores it —
 * `if (!pathname.startsWith("/api/")) return NextResponse.next()`.
 */
export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  const joined = (path ?? []).filter(Boolean).join("/");

  if (!FPL_ALLOWED_PATH.test(joined)) {
    return NextResponse.json(
      { error: "Not a permitted Fantasy Premier League path." },
      { status: 400 }
    );
  }

  return NextResponse.redirect(`https://fantasy.premierleague.com/${joined}`, 302);
}
