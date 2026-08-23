"use client";

import { fplEntryUrl } from "@/lib/fpl-links";

/**
 * Link to a manager's page on the official FPL site.
 *
 * On the Android app-link problem, honestly: whether an
 * https://fantasy.premierleague.com link opens the Premier League app instead
 * of a browser tab is decided by Android, from the app's verified
 * assetlinks.json plus the user's per-app "Open supported links" setting.
 * A website cannot override that. If the app has verified app links, a plain
 * anchor already opens it today with no code from us.
 *
 * What we can do is best-effort: NEXT_PUBLIC_FPL_LINK_HOP routes clicks
 * through /go/fpl/* on our own origin. Some launchers do not re-resolve
 * intent filters across a redirect, so this sometimes stays in the browser.
 * It is off by default because it costs an invocation per click and breaks
 * "copy link address" — turn it on once it has been measured on a real
 * device. The durable fix is the in-app points breakdown, which makes this
 * link a convenience rather than the only way to see a score.
 */
export function FplEntryLink({
  fplId,
  gw,
  className,
  stopPropagation,
  title,
  children,
}: {
  fplId: string | number;
  gw?: number | null;
  className?: string;
  /** Fixture cards toggle expand on click — stop the click escaping the link. */
  stopPropagation?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const target = fplEntryUrl(fplId, gw);
  const href =
    process.env.NEXT_PUBLIC_FPL_LINK_HOP === "1"
      ? `/go/fpl/${target.split("/entry/")[1] ? `entry/${target.split("/entry/")[1]}` : ""}`
      : target;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title}
      onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
    >
      {children}
    </a>
  );
}
