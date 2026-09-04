/**
 * FPL Classic — turning the award registry into displayable groups.
 *
 * Extracted from standings.ts so the standings page and the winners page assemble awards through
 * exactly one path. The difference between them is a single flag, not a second implementation:
 * the winners page additionally asks for scopes whose period is not over yet.
 *
 * ⚠️ NO PRIZE, AMOUNT, OR CURRENCY FIELD EXISTS HERE OR ANYWHERE DOWNSTREAM, AND NONE MAY BE
 * ADDED. This platform announces winners; it does not list prizes.
 */

import { allScopes, isScopeReady, type AwardContext } from "./awards";

/**
 * How settled an award is — see the identical doc on the UI type in
 * app/[leagueSlug]/_components/fpl-classic/awards-shared.tsx. The three are different claims and
 * must never be collapsed into a boolean again.
 */
export type ClassicAwardStatus = "final" | "provisional" | "leading";

export interface ClassicAwardWinnerRow {
  entrantId: string;
  entryName: string;
  playerName: string;
  position: number;
  value: number;
  isTied: boolean;
  detail: Record<string, unknown> | null;
}

export interface ClassicAwardGroup {
  key: string;
  label: string;
  scope: "season" | "gameweek" | "month" | "special";
  scopeKey: string;
  status: ClassicAwardStatus;
  winners: ClassicAwardWinnerRow[];
}

export interface FrozenAwardRow {
  awardType: string;
  scopeKey: string;
  entrantId: string;
  position: number;
  value: number;
  isTied: boolean;
  detail: string | null;
}

export type EntrantLookup = Map<string, { entryName: string; playerName: string }>;

/** Group frozen rows by `awardType::scopeKey`, the key the assembly loop looks them up by. */
export function indexFrozenAwards(rows: FrozenAwardRow[]): Map<string, FrozenAwardRow[]> {
  const byScope = new Map<string, FrozenAwardRow[]>();
  for (const row of rows) {
    const k = `${row.awardType}::${row.scopeKey}`;
    const list = byScope.get(k) ?? [];
    list.push(row);
    byScope.set(k, list);
  }
  return byScope;
}

function nameWinner(entrantId: string, entrantById: EntrantLookup) {
  const e = entrantById.get(entrantId);
  return { entryName: e?.entryName ?? "—", playerName: e?.playerName ?? "—" };
}

/**
 * Every award scope worth showing, each labelled with how settled it is.
 *
 * Resolution order per scope, and the order matters:
 *   1. A frozen row wins outright — read verbatim, never re-derived. A published winner must not
 *      silently change because FPL corrected a score weeks later.
 *   2. Otherwise, if every gameweek the scope needs is settled, compute it — `provisional`.
 *   3. Otherwise, and only when `includeLeading`, compute it over the settled subset — `leading`.
 *      This is the one case that is NOT a winner, and the caller must say so.
 */
export function buildAwardGroups(
  ctx: AwardContext,
  frozenByScope: Map<string, FrozenAwardRow[]>,
  entrantById: EntrantLookup,
  opts: { includeLeading: boolean },
): ClassicAwardGroup[] {
  const groups: ClassicAwardGroup[] = [];

  for (const { award, scopeKey } of allScopes(ctx)) {
    const frozen = frozenByScope.get(`${award.key}::${scopeKey}`);
    if (frozen && frozen.length > 0) {
      groups.push({
        key: award.key,
        label: award.label,
        scope: award.scope,
        scopeKey,
        status: "final",
        winners: frozen.map((row) => ({
          entrantId: row.entrantId,
          ...nameWinner(row.entrantId, entrantById),
          position: row.position,
          value: row.value,
          isTied: row.isTied,
          detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
        })),
      });
      continue;
    }

    const ready = isScopeReady(ctx, award, scopeKey);
    if (!ready && !opts.includeLeading) continue;

    // requireComplete mirrors readiness exactly, so a ready scope is computed identically to the
    // way the freeze writer will compute it — the guarantee that a provisional result and the
    // frozen one it becomes cannot disagree.
    const result = award.compute(ctx, scopeKey, { requireComplete: ready });
    if (!result) continue;

    groups.push({
      key: award.key,
      label: award.label,
      scope: award.scope,
      scopeKey,
      status: ready ? "provisional" : "leading",
      winners: result.winners.map((w) => ({
        entrantId: w.entrantId,
        ...nameWinner(w.entrantId, entrantById),
        position: w.position,
        value: w.value,
        isTied: w.isTied,
        detail: w.detail ?? null,
      })),
    });
  }

  return groups;
}
