/**
 * Is a TVT chip wasted?
 *
 * "Wasted" means the chip was spent but produced nothing. It is NOT the same as invalid: an
 * invalid, unprocessed chip is a declaration that was rejected at submission and never played,
 * and it must stay hidden rather than being shown as a burnt chip.
 *
 * The state has accumulated three representations over time, and all three are live in the
 * database today, so detection has to accept all of them:
 *
 *  1. `wastedReason != null`   — set by the scorer. The only one that says WHY.
 *  2. `hadNegativeHits`        — originally Win-Win + net negative transfer hits, but the admin
 *                                import route sets it for ANY chip it marks wasted so that this
 *                                check lights up consistently (see import-chips/route.ts).
 *  3. `isProcessed && !isValid` — the admin import / override shape.
 *
 * This helper is the one place that knows all three, so the expression is not retyped — it was
 * already duplicated between override-chips and the admin page before this existed.
 *
 * ⚠️ New waste must be recorded as `wastedReason`, never by flipping `isValid` to false. The
 * force-reprocess reset in api/gameweeks/[gw]/route.ts clears isProcessed / pointsAwarded /
 * hadNegativeHits / wastedReason but deliberately leaves `isValid` alone — so a chip the scorer
 * invalidated would be excluded from the scorer's own `isValid: true` query on every later
 * reprocess, silently and permanently.
 *
 * Pure and import-free so it unit-tests without a database.
 */

export interface WastableChip {
  isProcessed: boolean;
  isValid: boolean;
  hadNegativeHits: boolean;
  wastedReason?: string | null;
}

export function isChipWasted(chip: WastableChip): boolean {
  if (chip.wastedReason != null && chip.wastedReason !== "") return true;
  if (chip.hadNegativeHits) return true;
  return chip.isProcessed && !chip.isValid;
}

/**
 * Should this chip be shown at all?
 *
 * A wasted chip is shown — that is the point of surfacing waste. A chip that is invalid and was
 * never processed is a rejected declaration: it was never played, so showing it would tell the
 * league a team spent something it did not.
 */
export function isChipDisclosable(chip: WastableChip): boolean {
  return chip.isValid || isChipWasted(chip);
}
