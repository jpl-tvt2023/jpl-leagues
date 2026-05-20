// Pure client-safe helpers around the persisted `auction_scores.club_result_summary` string.
//
// Pre-fix scoring runs stored the summary as `"${plTeamName} (${tier}): ${scoreline} = +${bonus}"`,
// which made tooltips repetitive once consumers also prefixed `GW${n}:`. The current format is just
// the clean scoreline (`"Brentford 3-0 Man Utd → +3"`). `normalizeClubSummary` strips the legacy
// prefix/suffix so tooltips render consistently for old GWs until those rows are reprocessed.

export function normalizeClubSummary(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  const legacy = /^[^:]+\s\((top8|mid|promoted)\):\s(.*?)\s=\s\+[-\d]+\s*$/.exec(raw);
  if (legacy) return legacy[2];
  return raw;
}
