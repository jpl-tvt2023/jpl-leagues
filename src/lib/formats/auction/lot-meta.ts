import { fetchElementInfo } from "@/lib/fpl";
import { loadStandingsConfig } from "./club-auction";
import { resolveTier } from "@/lib/data/pl-standings-seed";
import type { ClubTier } from "@/lib/db/schema";

/**
 * Identity of whatever is on the block, resolved server-side so the admin room and the participant
 * room can never disagree.
 *
 * The id space is the subtle part. `auction_bids.fplElementId` holds a **player** id in
 * `initial` / `mini-auction` sessions, but is re-purposed to hold a **PL team** id in
 * `club-auction` sessions. For a player we therefore have to hop player → `element.team` → club.
 * That hop is valid because the bootstrap element's `team` field is the same id space as
 * `auctionClubOwnership.plTeamId` and the standings config (the same assumption `scoring.ts` relies
 * on for its synergy bonus).
 *
 * Club *names* are deliberately not included: every client already loads `/api/fpl/bootstrap` and
 * has the `teams[]` map, so shipping names per poll would be redundant bytes.
 */
export interface LotMeta {
  /** FPL element_type (1=GKP … 4=FWD). Null for club auctions. */
  elementType: number | null;
  /** The player's real-life PL club id — or, for a club auction, the club itself. */
  plTeamId: number | null;
  tier: ClubTier | null;
}

export const EMPTY_LOT_META: LotMeta = { elementType: null, plTeamId: null, tier: null };

/**
 * Standings config changes at most once a gameweek but `GET /api/auction/session` is polled every
 * 3s by every connected client, so memoise it rather than hitting the DB on each one.
 */
const CONFIG_TTL_MS = 5 * 60_000;
let configCache: { value: { top8: number[]; mid: number[]; promoted: number[] }; at: number } | null = null;

async function getStandingsConfig() {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  const { top8, mid, promoted } = await loadStandingsConfig();
  configCache = { value: { top8, mid, promoted }, at: Date.now() };
  return configCache.value;
}

/**
 * Build a resolver for one session. Both lookups behind it are cached (`fetchElementInfo` for 24h,
 * standings config for 5 min), so this is safe to call on the SSE stream's 2s poll.
 *
 * Returns a synchronous resolver so callers can use it inline while building payloads.
 */
export async function buildLotMetaResolver(
  isClubAuction: boolean
): Promise<(fplElementId: number) => LotMeta> {
  let config: { top8: number[]; mid: number[]; promoted: number[] } | null = null;
  try {
    config = await getStandingsConfig();
  } catch (e) {
    console.warn("[lot-meta] standings config unavailable — tier will be null", e);
  }

  // Club auctions carry a PL team id directly; no element lookup needed.
  if (isClubAuction) {
    return (plTeamId: number): LotMeta => ({
      elementType: null,
      plTeamId,
      tier: config ? resolveTier(plTeamId, config) : null,
    });
  }

  let elementById: Map<number, { element_type: number; team: number }> | null = null;
  try {
    const elements = await fetchElementInfo();
    elementById = new Map(elements.map((e) => [e.id, { element_type: e.element_type, team: e.team }]));
  } catch (e) {
    console.warn("[lot-meta] bootstrap unavailable — position/club will be null", e);
  }

  return (fplElementId: number): LotMeta => {
    const el = elementById?.get(fplElementId);
    if (!el) return EMPTY_LOT_META;
    return {
      elementType: el.element_type,
      plTeamId: el.team,
      tier: config ? resolveTier(el.team, config) : null,
    };
  };
}
