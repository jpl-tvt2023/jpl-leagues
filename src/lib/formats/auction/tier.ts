// Auction tier — controls which features are available within an auction-format league.
//
// - "primary": auction + GW payouts + penalty-slot redemption ONLY.
//              Trades and slot-15/16 expansion are disabled.
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
