import { NextResponse } from "next/server";

/**
 * JSON response that no shared cache may keep.
 *
 * These routes serve per-league, frequently per-viewer data and today rely entirely on
 * Next's default for dynamic route handlers. That default is correct, but it is an
 * implicit dependency rather than a stated one — and `/api/fpl-classic/standings` is
 * public and unauthenticated (allowlisted in middleware.ts), so any CDN or proxy in
 * front of it that applies heuristic caching would serve one league's payload to
 * everyone. Saying it explicitly costs a header.
 */
export function jsonNoStore(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  return res;
}
