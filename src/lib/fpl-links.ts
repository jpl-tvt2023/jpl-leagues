/**
 * Links to a manager's page on the official FPL site.
 *
 * Centralised because there were a dozen hand-rolled template literals across
 * the app, two of which were subtly wrong (see below), and because the
 * Android app-link behaviour is something we want to be able to change in one
 * place rather than twelve.
 *
 * No "use client" — the server-side payload builders in
 * api/team/dashboard/* import fplEntryUrl too.
 */

const FPL_SITE = "https://fantasy.premierleague.com";

/**
 * URL for an entry's gameweek page, or their season history when no gameweek
 * applies.
 *
 * The guard matters. Callers used to write `getFplTeamUrl(fplId, gw || undefined)`,
 * and at GW1 `latestCompletedGW` is `0`, so `0 || undefined` silently produced
 * a /history link where a points page was intended. Treat anything below 1 as
 * "no gameweek" explicitly instead of relying on falsiness.
 *
 * FPL only resolves /event/{n} once GW n's deadline has passed, so callers
 * should pass the latest *started* gameweek, not the one being viewed.
 */
export function fplEntryUrl(fplId: string | number, gw?: number | null): string {
  const n = Number(gw);
  if (Number.isFinite(n) && n >= 1) {
    return `${FPL_SITE}/entry/${fplId}/event/${Math.trunc(n)}`;
  }
  return `${FPL_SITE}/entry/${fplId}/history`;
}

/**
 * Short label for a link built by fplEntryUrl.
 *
 * Also a bug guard: the dashboard rendered `GW{lastCompletedGw ?? …}`, and
 * since `0` is not nullish the `??` never fired — the pill read "GW0" for the
 * whole of gameweek 1.
 */
export function fplEntryLabel(gw?: number | null): string {
  const n = Number(gw);
  return Number.isFinite(n) && n >= 1 ? `GW${Math.trunc(n)}` : "History";
}

/**
 * Path segments we are willing to redirect to through /go/fpl/*.
 * Anything else is refused — an unvalidated redirector is an open redirect.
 */
export const FPL_ALLOWED_PATH = /^entry\/\d{1,12}\/(event\/\d{1,2}|history)$/;
