export interface ChipTooltipEntry {
  label: string;
  status: "available" | "used" | "pending";
  points: number;
  gameweek?: number;
  opponent?: string;
}

export interface TeamStanding {
  teamId: string;
  name: string;
  group: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  pointsFor: number;
  /**
   * Tiebreaker tier 6: each player's FPL points net of hits, with NO captain doubling.
   * `pointsFor` (tier 2) is the same scoring WITH the captain doubled, so the two differ.
   */
  fplNetScore: number;
  pointsAgainst: number;
  pointsDiff: number;
  leaguePoints: number;
  bonusPoints: number;
  calculatedBonus: number;
  chipPoints: number;
  cbpPoints: number;
  cbpTooltip: {
    chips: ChipTooltipEntry[];
    bps: { gameweek: number; points: number }[];
    hitPenalty: {
      penaltyGws: { gameweek: number; playerName: string; hits: number }[];
      totalDeduction: number;
    };
  };
  groupRank: number;
  zone: "playoffs" | "challenger" | "eliminated";
  /** Group rank as of the previous gameweek; null if there isn't one yet. */
  previousRank?: number | null;
  /** previousRank − groupRank (positive = climbed). null if no prior GW. */
  rankDelta?: number | null;
}
