export function computeCaptainCap(leagueFormat: string, playoffStartGw: number | null): number {
  const nonPlayoffGws = leagueFormat === "triple-crown" ? 38 : ((playoffStartGw ?? 31) - 1);
  return Math.ceil(nonPlayoffGws / 2);
}

export function computeCaptainCheckLimit(leagueFormat: string, playoffStartGw: number | null): number {
  return leagueFormat === "triple-crown" ? 38 : ((playoffStartGw ?? 31) - 1);
}
