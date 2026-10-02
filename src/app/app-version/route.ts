import { NextResponse } from "next/server";

// Rendered once at build time, so it reports the version of the deploy that is serving it.
export const dynamic = "force-static";

/**
 * The live deploy's version. PwaProvider compares it against the version baked into the page the
 * user has open (an installed app can stay open for days) and offers "Update available — Reload"
 * when they differ. Lives outside /api so it needs no session and the middleware never sees it.
 */
export function GET() {
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev" },
    { headers: { "Cache-Control": "no-cache" } },
  );
}
