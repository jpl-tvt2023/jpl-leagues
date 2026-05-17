import { NextRequest, NextResponse } from "next/server";
import { countPlayersLeftToPlay } from "@/lib/fpl-live/players-left";

/**
 * GET /api/fpl/players-left?gw=N&elements=1,2,3,...
 *
 * Returns { leftToPlay, total, isLive } where leftToPlay is the sum across
 * input elements of unstarted-fixture counts in the given GW.
 *
 * Validation:
 *   - gw must be 1-38
 *   - elements is required, comma-separated integers, max 200 entries
 *
 * Caching is handled inside countPlayersLeftToPlay (60s Redis cache on the
 * underlying FPL fixtures fetch).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const gwParam = parseInt(searchParams.get("gw") ?? "", 10);
  if (!Number.isFinite(gwParam) || gwParam < 1 || gwParam > 38) {
    return NextResponse.json({ error: "gw must be 1-38" }, { status: 400 });
  }

  const elementsRaw = searchParams.get("elements") ?? "";
  if (!elementsRaw) {
    return NextResponse.json({ error: "elements is required" }, { status: 400 });
  }
  const elementIds = elementsRaw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (elementIds.length === 0) {
    return NextResponse.json({ error: "elements must contain at least one valid ID" }, { status: 400 });
  }
  if (elementIds.length > 200) {
    return NextResponse.json({ error: "elements limited to 200 IDs per request" }, { status: 400 });
  }

  const result = await countPlayersLeftToPlay(elementIds, gwParam);
  if (!result) {
    // FPL outage — surface null so the client can show "—" rather than 0.
    return NextResponse.json({ leftToPlay: null, total: elementIds.length, isLive: false });
  }
  return NextResponse.json(result);
}
