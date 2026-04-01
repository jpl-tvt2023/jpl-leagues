import { NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE_NAME } from "@/lib/auth";
import { Redis } from "@upstash/redis";

// ---------- Rate limiter via Upstash Redis ----------
let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (!redis && process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

async function rateLimit(key: string, maxAttempts: number, windowMs: number): Promise<boolean> {
  const kv = getRedis();
  if (!kv) return true; // Skip rate limiting if Redis not configured (local dev)

  const redisKey = `rl:${key}`;
  const count = await kv.incr(redisKey);
  if (count === 1) {
    await kv.expire(redisKey, Math.ceil(windowMs / 1000));
  }
  return count <= maxAttempts;
}

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

// ---------- Route classification ----------

const PUBLIC_ROUTES = [
  "/api/auth/signin",
  "/api/auth/signout",
  "/api/auth/me",
  "/api/fixtures",
  "/api/standings",
  "/api/playoffs/bracket",
  "/api/playoffs/winners",
  "/api/leagues",
];

function isPublicRoute(pathname: string, method: string): boolean {
  // Auth routes are always public
  if (pathname.startsWith("/api/auth/")) return true;

  // Public GET-only routes
  if (method === "GET") {
    if (PUBLIC_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))) return true;
    // GET /api/gameweeks/[gw] is public read
    if (/^\/api\/gameweeks\/\d+$/.test(pathname)) return true;
    // GET /api/fixtures/generate (status check) is public
    if (pathname === "/api/fixtures/generate") return true;
  }

  return false;
}

function isAdminRoute(pathname: string, method: string): boolean {
  if (pathname.startsWith("/api/admin/")) return true;
  // POST to these are admin-only
  if (method === "POST" && pathname === "/api/fixtures/generate") return true;
  if (method === "POST" && /^\/api\/gameweeks\/\d+$/.test(pathname)) return true;
  return false;
}

// Extract leagueId from /api/admin/[leagueId]/... paths
function extractLeagueId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/admin\/([^/]+)\//);
  return match ? match[1] : null;
}

function isTeamRoute(pathname: string): boolean {
  return pathname.startsWith("/api/team/");
}

// ---------- Rate-limited routes ----------

const RATE_LIMITED_ROUTES: Record<string, { max: number; windowMs: number }> = {
  "/api/auth/signin": { max: 5, windowMs: 60_000 },
  "/api/auth/change-password": { max: 5, windowMs: 60_000 },
};

// Rate limit reset-season regardless of leagueId in path
function isResetSeasonRoute(pathname: string): boolean {
  return /^\/api\/admin\/[^/]+\/reset-season$/.test(pathname);
}

// ---------- Middleware ----------

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const method = request.method;

  // Only handle API routes
  if (!pathname.startsWith("/api/")) return NextResponse.next();

  // Rate limiting check
  for (const [route, limits] of Object.entries(RATE_LIMITED_ROUTES)) {
    if (pathname === route && method === "POST") {
      const ip = getClientIp(request);
      if (!(await rateLimit(`${route}:${ip}`, limits.max, limits.windowMs))) {
        return NextResponse.json(
          { error: "Too many requests. Please try again later." },
          { status: 429 }
        );
      }
    }
  }
  // Rate limit reset-season (dynamic path)
  if (isResetSeasonRoute(pathname) && method === "POST") {
    const ip = getClientIp(request);
    if (!(await rateLimit(`reset-season:${ip}`, 1, 60_000))) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }
  }

  // Public routes — no auth needed
  if (isPublicRoute(pathname, method)) {
    return NextResponse.next();
  }

  // Cron job auth — Vercel sends Authorization: Bearer <CRON_SECRET>
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader === `Bearer ${cronSecret}`) {
      if (pathname.startsWith("/api/cron/") || isAdminRoute(pathname, method)) {
        const response = NextResponse.next();
        response.headers.set("x-session-id", "cron");
        response.headers.set("x-session-type", "admin");
        return response;
      }
    }
    // Cron routes require valid secret — reject if missing/wrong
    if (pathname.startsWith("/api/cron/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (pathname.startsWith("/api/cron/")) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  // All other API routes require a valid session
  const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const session = await verifySession(sessionCookie);
  if (!session) {
    return NextResponse.json({ error: "Invalid or expired session" }, { status: 401 });
  }

  // Admin routes require admin or superadmin session
  if (isAdminRoute(pathname, method)) {
    if (session.type !== "admin" && session.type !== "superadmin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    // Forward verified session info + leagueId as headers for route handlers
    const response = NextResponse.next();
    response.headers.set("x-session-id", session.id);
    response.headers.set("x-session-type", session.type);
    const leagueId = extractLeagueId(pathname);
    if (leagueId) response.headers.set("x-league-id", leagueId);
    return response;
  }

  // Team routes require team session
  if (isTeamRoute(pathname)) {
    if (session.type !== "team") {
      return NextResponse.json({ error: "Team access required" }, { status: 403 });
    }
    const response = NextResponse.next();
    response.headers.set("x-session-id", session.id);
    response.headers.set("x-session-type", session.type);
    return response;
  }

  // Any other API route — require auth but allow either type
  const response = NextResponse.next();
  response.headers.set("x-session-id", session.id);
  response.headers.set("x-session-type", session.type);
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
