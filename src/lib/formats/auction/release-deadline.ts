/**
 * JPL Auction — the release deadline.
 *
 * Pending releases are confirmed (refund credited, player back in the pool) at one moment: 24 hours
 * before the next mini-auction is scheduled to start. Everyone then has a day to see the final list
 * of available players before bidding opens, and from then until that auction is over teams can't
 * mark or cancel a release. An auction started early, or with no scheduled time, confirms whatever
 * is still pending when it starts.
 *
 * With no mini-auction scheduled there is no deadline yet. The timer then counts to the next GW
 * deadline as a tentative placeholder — nothing happens when it passes.
 *
 * Zero imports on purpose (same reasoning as cycle.ts) so this unit-tests without a DB and can be
 * called from client components.
 */

/** How long before a mini-auction's scheduled start its release deadline falls. */
export const RELEASE_DEADLINE_HOURS = 24;

export interface ScheduledMiniAuction {
  cycleNumber: number;
  scheduledAt: Date;
}

/** The release deadline for a mini-auction scheduled at `scheduledAt`. */
export function releaseDeadline(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() - RELEASE_DEADLINE_HOURS * 60 * 60 * 1000);
}

/**
 * Has the next mini-auction's release deadline passed? From then until that auction is over,
 * pending releases are confirmed and new ones can't be marked or cancelled. False when no
 * mini-auction is scheduled.
 */
export function isReleaseWindowClosed(nextMini: { scheduledAt: Date } | null, now: Date = new Date()): boolean {
  return nextMini != null && now >= releaseDeadline(nextMini.scheduledAt);
}

/**
 * What the release timer counts down to. `at` is ISO so it travels as JSON to every page that
 * shows the timer. `tentative` means no mini-auction is scheduled and `at` is only the next GW
 * deadline, a placeholder; nothing is confirmed then.
 */
export type ReleaseCountdown =
  | { at: string; tentative: false; cycleNumber: number }
  | { at: string; tentative: true; gw: number };

/**
 * The timer target: the next mini-auction's release deadline, otherwise the next GW deadline as a
 * tentative stand-in, otherwise null (no auction scheduled and no gameweek left).
 */
export function releaseCountdown(
  nextMini: ScheduledMiniAuction | null,
  nextGw: { number: number; deadline: Date } | null
): ReleaseCountdown | null {
  if (nextMini) {
    return { at: releaseDeadline(nextMini.scheduledAt).toISOString(), tentative: false, cycleNumber: nextMini.cycleNumber };
  }
  if (nextGw) return { at: nextGw.deadline.toISOString(), tentative: true, gw: nextGw.number };
  return null;
}

/** Client-side twin of isReleaseWindowClosed, for a countdown that came over the wire. */
export function isCountdownClosed(countdown: ReleaseCountdown | null, nowMs: number): boolean {
  return countdown != null && !countdown.tentative && nowMs >= Date.parse(countdown.at);
}

/**
 * When pending releases get confirmed (refund credited, player leaves the squad) — the one sentence
 * every screen uses, so squad, marketplace, admin and dialog copy can't drift apart.
 */
export function describeReleaseConfirmation(countdown: ReleaseCountdown | null): string {
  return countdown && !countdown.tentative
    ? `Confirmed and paid ${RELEASE_DEADLINE_HOURS} hours before Mini-Auction #${countdown.cycleNumber} starts.`
    : `Confirmed and paid ${RELEASE_DEADLINE_HOURS} hours before the next mini-auction starts — none is scheduled yet.`;
}
