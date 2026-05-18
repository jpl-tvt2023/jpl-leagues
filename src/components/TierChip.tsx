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
}

const TIER_STYLE: Record<ClubTier, string> = {
  top8:     "bg-yellow-500/20 text-yellow-200 border-yellow-500/40",
  mid:      "bg-blue-500/20 text-blue-200 border-blue-500/40",
  promoted: "bg-emerald-500/20 text-emerald-200 border-emerald-500/40",
};

const TIER_BONUS: Record<ClubTier, string> = {
  top8:     "+2W/+1D per fixture",
  mid:      "+3W/+1D per fixture",
  promoted: "+4W/+2D per fixture",
};

export function TierChip({ tier, clubName, short, compact }: TierChipProps) {
  const label = compact ? (short ?? "") : TIER_LABEL[tier];
  return (
    <span
      title={`Owns ${clubName} — ${TIER_LABEL[tier]} tier. Synergy ×1.5 on owned ${clubName} players; club-result bonus ${TIER_BONUS[tier]}.`}
      className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${TIER_STYLE[tier]}`}
    >
      {label}
    </span>
  );
}
