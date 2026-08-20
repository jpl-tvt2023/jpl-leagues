// Tier chip for PL Club Auction owned-club display.
//
// Renders next to the team name everywhere a team is listed. The chip's colour reflects the club's
// tier (top8 / mid / promoted), and a tooltip explains the perks. Used by Standings, GW Results,
// Teams page, Dashboard, Admin views.

import type { ClubTier } from "@/lib/db/schema";
import { TIER_LABEL } from "@/lib/teams/display-name";

interface TierChipProps {
  tier: ClubTier;
  clubName: string;
  short?: string;
  // If true, render an extra-compact pill (no name, just short code). Used in dense table cells.
  compact?: boolean;
  /**
   * Who the chip is describing.
   *  - "owner" (default): a team that OWNS this club — the original use, next to a team name.
   *  - "player": a player who PLAYS for this club — used on the auction block, where the owner
   *    wording ("Owns Arsenal…") would be plainly wrong.
   */
  variant?: "owner" | "player";
}

const TIER_STYLE: Record<ClubTier, string> = {
  top8:     "bg-yellow-500/20 text-yellow-200 border-yellow-500/40",
  mid:      "bg-blue-500/20 text-blue-200 border-blue-500/40",
  promoted: "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
};

// Mirrors CLUB_TIER_BONUS in src/lib/formats/auction/club-auction.ts — the actual scoring values.
const TIER_BONUS: Record<ClubTier, string> = {
  top8:     "+4W/+2D per fixture",
  mid:      "+6W/+3D per fixture",
  promoted: "+8W/+4D per fixture",
};

export function TierChip({ tier, clubName, short, compact, variant = "owner" }: TierChipProps) {
  const label = compact ? (short ?? "") : TIER_LABEL[tier];
  const title =
    variant === "player"
      ? `Plays for ${clubName} — ${TIER_LABEL[tier]} tier. Worth Synergy ×1.5 to whoever owns ${clubName}; club-result bonus ${TIER_BONUS[tier]}.`
      : `Owns ${clubName} — ${TIER_LABEL[tier]} tier. Synergy ×1.5 on owned ${clubName} players; club-result bonus ${TIER_BONUS[tier]}.`;
  return (
    <span
      title={title}
      className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${TIER_STYLE[tier]}`}
    >
      {label}
    </span>
  );
}
