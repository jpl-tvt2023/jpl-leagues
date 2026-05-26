/**
 * Factory helpers that create leagues via POST /api/superadmin/leagues.
 *
 * The create-league endpoint also auto-creates `teamSize` placeholder team
 * accounts with login IDs `${slug}Team${i}` and passwords `Team@${padded(i)}`
 * (see src/app/api/superadmin/leagues/route.ts). Specs receive a `LeagueRef`
 * with slug, id, and team count — everything they need to drive the rest of
 * the suite.
 *
 * Caller must have signed in as the test superadmin first (apiSignInSuperadmin).
 */

import type { APIRequestContext } from "@playwright/test";

export interface LeagueRef {
  id: string;
  slug: string;
  name: string;
  format: "tvt" | "triple-crown" | "auction";
  teamSize: number;
  /** Only set for auction leagues. */
  auctionTier?: "primary" | "complete";
}

/**
 * Generate a slug unique to this test run (lowercase, dash-safe).
 *
 * Must stay short: /api/team/setup enforces a 3–20 char loginId regex on
 * `<slug>Team<NN>`, so for a 32-team league with two-digit indexes the slug
 * itself must be ≤ 14 chars. We use 6 chars of timestamp (millisecond base36)
 * plus a 2-char random tail — collision-resistant within a single run, short
 * enough for any prefix up to ~5 chars.
 */
export function uniqueSlug(prefix: string): string {
  const stamp = Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 4);
  return `${prefix}-${stamp}`.toLowerCase();
}

async function createLeague(
  request: APIRequestContext,
  payload: Record<string, unknown>,
): Promise<LeagueRef> {
  const res = await request.post("/api/superadmin/leagues", { data: payload, failOnStatusCode: false });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) {
    throw new Error(
      `POST /api/superadmin/leagues failed (${res.status()}): ${body?.error ?? JSON.stringify(body)}`,
    );
  }
  return {
    id: body.id,
    slug: body.slug,
    name: body.name,
    format: body.format,
    teamSize: body.teamSize,
    auctionTier: body.auctionTier,
  };
}

export async function createTvtLeague(
  request: APIRequestContext,
  opts: { teams: 8 | 16 | 32; slug?: string; name?: string; enabledChips?: string[] },
): Promise<LeagueRef> {
  const slug = opts.slug ?? uniqueSlug(`t${opts.teams}`);
  return createLeague(request, {
    slug,
    name: opts.name ?? `TVT ${opts.teams}`,
    sport: "fpl",
    format: "tvt",
    season: "2025-26",
    teamSize: opts.teams,
    enabledChips: opts.enabledChips ?? ["D", "W", "C"],
  });
}

export async function createTripleCrownLeague(
  request: APIRequestContext,
  opts: { slug?: string; name?: string } = {},
): Promise<LeagueRef> {
  const slug = opts.slug ?? uniqueSlug("tc");
  return createLeague(request, {
    slug,
    name: opts.name ?? "Triple Crown 20",
    sport: "fpl",
    format: "triple-crown",
    season: "2025-26",
  });
}

export async function createAuctionLeague(
  request: APIRequestContext,
  opts: {
    tier: "primary" | "complete";
    slug?: string;
    name?: string;
    clubAuctionEnabled?: boolean;
    /**
     * isSimulated=true means starting the auction session auto-allocates players
     * via the snake-draft simulator (see src/lib/formats/auction/simulate.ts).
     * Cuts auction setup from minutes of clicking to milliseconds. Default true.
     */
    isSimulated?: boolean;
  },
): Promise<LeagueRef> {
  const slug = opts.slug ?? uniqueSlug(opts.tier === "primary" ? "ap" : "ac");
  const teams = opts.tier === "primary" ? 10 : 14;
  return createLeague(request, {
    slug,
    name: opts.name ?? `Auction ${opts.tier} ${teams}`,
    sport: "fpl",
    format: "auction",
    season: "2025-26",
    teamSize: teams,
    auctionTier: opts.tier,
    isSimulated: opts.isSimulated ?? true,
    clubAuctionEnabled: opts.clubAuctionEnabled ?? false,
  });
}

/**
 * Hard delete a league via DELETE /api/superadmin/leagues/[id].
 * Optional cleanup hook for specs that want to leave test.db tidy; the global
 * `npm run test:reset` is usually enough between runs.
 */
export async function deleteLeague(request: APIRequestContext, id: string): Promise<void> {
  const res = await request.delete(`/api/superadmin/leagues/${id}`, { failOnStatusCode: false });
  if (!res.ok() && res.status() !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`deleteLeague(${id}) failed: ${res.status()} ${body?.error ?? ""}`);
  }
}
