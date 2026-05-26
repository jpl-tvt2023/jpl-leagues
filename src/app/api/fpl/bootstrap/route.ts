import { NextResponse } from "next/server";
import { fetchElementInfo, fetchBootstrapData } from "@/lib/fpl";

/**
 * GET /api/fpl/bootstrap
 *
 * Client-accessible FPL bootstrap data for auction pages: player search in the
 * nomination modal, squad labels (position/team), and marketplace player cards.
 *
 * Returns a trimmed shape — only the fields the client actually uses.
 * Cached server-side via fetchElementInfo() (24hr TTL).
 *
 * Auth: PUBLIC. The underlying FPL bootstrap is already publicly cached by the
 * Premier League and exposes no league-private data, so this passthrough is
 * available without a session (matches the route name).
 */
export async function GET() {
  try {
    // Elements come from the cached path
    const elements = await fetchElementInfo();

    // Teams are small and not needed elsewhere cached individually — pull from bootstrap once.
    // fetchElementInfo() already warms the bootstrap cache indirectly, but we still need teams.
    const bootstrap = await fetchBootstrapData();
    const rawTeams = (bootstrap.teams ?? []) as Array<{
      id: number;
      name: string;
      short_name: string;
    }>;
    const teams = rawTeams.map((t) => ({
      id: t.id,
      name: t.name,
      short_name: t.short_name,
    }));

    return NextResponse.json({ elements, teams });
  } catch (err) {
    console.error("Failed to fetch FPL bootstrap:", err);
    return NextResponse.json(
      { error: "Failed to fetch FPL bootstrap data" },
      { status: 502 }
    );
  }
}
