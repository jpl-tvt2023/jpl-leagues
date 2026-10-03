/**
 * This season's FPL chip list, cache-only.
 *
 * Read from the copy of bootstrap-static's `chips` cached whenever bootstrap is fetched anyway
 * (fpl.ts → cacheSeasonChipsFrom). Never fetches: the callers include public routes that must
 * not fan out to FPL. Falls back to DEFAULT_SEASON_CHIPS when nothing is cached — a cold cache
 * shows this season's known rules, never an empty chip row.
 */

import { getCachedSeasonChips } from "@/lib/fpl-cache";
import { DEFAULT_SEASON_CHIPS, type FplSeasonChip } from "./chips";

export async function getSeasonChips(): Promise<readonly FplSeasonChip[]> {
  try {
    return (await getCachedSeasonChips()) ?? DEFAULT_SEASON_CHIPS;
  } catch {
    return DEFAULT_SEASON_CHIPS;
  }
}
