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
  abbreviation: string;
  group: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  pointsFor: number;
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
}
