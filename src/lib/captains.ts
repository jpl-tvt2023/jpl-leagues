export function computeCaptainCap(leagueFormat: string, playoffStartGw: number | null): number {
  const nonPlayoffGws = leagueFormat === "continental-championship" ? 38 : ((playoffStartGw ?? 31) - 1);
  return Math.ceil(nonPlayoffGws / 2);
}

export function computeCaptainCheckLimit(leagueFormat: string, playoffStartGw: number | null): number {
  return leagueFormat === "continental-championship" ? 38 : ((playoffStartGw ?? 31) - 1);
}
