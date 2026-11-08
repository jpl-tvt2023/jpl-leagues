"use client";

import { useEffect, useRef, useState } from "react";
import { RELEASE_DEADLINE_HOURS, type ReleaseCountdown } from "@/lib/formats/auction/release-deadline";

/** "Sun 15 Nov, 18:00" in the viewer's own timezone. */
function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "2d 04h 12m 09s" — days only once there are any. */
function formatRemaining(ms: number): string {
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hms = `${pad(Math.floor((total % 86400) / 3600))}h ${pad(Math.floor((total % 3600) / 60))}m ${pad(total % 60)}s`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

/**
 * Countdown to the release deadline — when pending releases are confirmed and the refunds paid,
 * 24 hours before the next mini-auction. With no mini-auction scheduled it counts to the next GW
 * deadline instead, marked tentative: nothing happens then, it's only a placeholder.
 *
 * `onDeadline` fires once when a countdown this component watched running reaches zero (never for
 * one that had already passed when it mounted, so a reload can't loop). Reloading then confirms a
 * real deadline and moves a tentative one on to the next GW.
 */
export function ReleaseDeadlineTimer({
  countdown,
  onDeadline,
}: {
  countdown: ReleaseCountdown | null;
  onDeadline?: () => void;
}) {
  // Lazy initializer keeps Date.now() out of the render path (React purity rule).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!countdown) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [countdown]);

  const at = countdown ? Date.parse(countdown.at) : null;
  const passed = at != null && at - now <= 0;

  const armedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!countdown) return;
    if (!passed) armedFor.current = countdown.at;
    else if (armedFor.current === countdown.at) {
      armedFor.current = null;
      onDeadline?.();
    }
  }, [passed, countdown, onDeadline]);

  if (!countdown || at == null) {
    return (
      <p className="text-[11px] text-gray-400">
        No mini-auction is scheduled yet. Releases are confirmed and paid {RELEASE_DEADLINE_HOURS} hours before it starts.
      </p>
    );
  }

  let label: string;
  let caption: string;
  if (countdown.tentative) {
    label = `GW${countdown.gw} deadline`;
    caption =
      `No mini-auction is scheduled yet, so this is only the GW${countdown.gw} deadline — nothing is confirmed then. ` +
      `Releases are confirmed and paid ${RELEASE_DEADLINE_HOURS} hours before the next mini-auction once it's scheduled.`;
  } else if (passed) {
    label = "Releases confirmed";
    caption = `Pending releases were confirmed and paid ${RELEASE_DEADLINE_HOURS} hours before Mini-Auction #${countdown.cycleNumber}. Releases reopen once it's over.`;
  } else {
    label = `Release deadline · Mini-Auction #${countdown.cycleNumber}`;
    caption =
      `Releases are confirmed and paid at ${formatWhen(at)}, ${RELEASE_DEADLINE_HOURS} hours before the auction starts ` +
      `(${formatWhen(at + RELEASE_DEADLINE_HOURS * 60 * 60 * 1000)}). You can mark or cancel releases until then.`;
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-gray-400">
          {label}
          {countdown.tentative && (
            <span className="rounded border border-yellow-500/40 bg-yellow-500/15 px-1.5 py-0.5 font-bold text-yellow-300">Tentative</span>
          )}
        </div>
        <div className={`font-mono text-xl font-bold ${passed ? "text-green-300" : countdown.tentative ? "text-gray-300" : "text-white"}`}>
          {passed ? (countdown.tentative ? "Now" : "Done") : formatRemaining(at - now)}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-gray-400">{caption}</p>
    </div>
  );
}
