// Auction tier — controls which features are available within an auction-format league.
//
// - "primary": auction + GW payouts + mini-auctions + penalty-slot redemption ONLY.
//              Trades and slot-16/17/18 expansion are disabled — and ONLY those two.
//              GW payouts are deliberately included and use the same GW_PAYOUTS schedule as
//              "complete"; the purse sink is the mini-auction. Do not re-add a payout gate here.
// - "complete": all features (current default for legacy leagues).
//
// Persisted on `leagues.auctionTier`. Surfaced to clients via /api/auth/me and the league context.

export type AuctionTier = "primary" | "complete";

export const isComplete = (tier?: AuctionTier | null): boolean => tier === "complete";
export const isPrimary = (tier?: AuctionTier | null): boolean => tier === "primary";

/** Features that the primary tier disables. Centralised so adding/removing a gate is one edit. */
export const PRIMARY_DISABLED_FEATURES = {
  trades: true,
  slotExpansion: true,
} as const;
