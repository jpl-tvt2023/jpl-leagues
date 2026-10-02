"use client";

import { useEffect, useState } from "react";

/** Pull distance (after resistance) that arms a refresh on release. */
const THRESHOLD = 72;
/** The indicator stops following the finger past this. */
const MAX_PULL = 120;
/** Finger travel → indicator travel. Below 1 so the pull feels weighted, like native. */
const RESISTANCE = 0.5;

/**
 * Android-style pull-to-refresh, for every page.
 *
 * An installed app (standalone display mode) gets no browser pull-to-refresh at all, so without
 * this there was no way to refresh a page short of closing the app. In a browser tab this replaces
 * Chrome's native one — globals.css turns that off with `overscroll-behavior-y: none` so the two
 * never fire together — which keeps the gesture identical in the tab and the installed app.
 *
 * Refresh is a full reload: pages load their data in client effects, which a soft router refresh
 * would not re-run.
 *
 * A pull only starts when:
 *  - the page is scrolled to the very top,
 *  - no drawer or sheet is open (they lock body scroll),
 *  - the touch didn't begin inside an inner scroller that is itself scrolled down,
 *  - no element on the page opts out with `data-pull-refresh="off"` (the live auction room,
 *    where an accidental reload mid-bid would hurt),
 * and it is cancelled as soon as the gesture turns out to be mostly horizontal (drawer swipes).
 */
export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    let decided = false;
    let distance = 0;

    const canStart = (target: EventTarget | null): boolean => {
      if (window.scrollY > 0) return false;
      if (document.body.style.overflow === "hidden") return false;
      if (document.querySelector('[data-pull-refresh="off"]')) return false;
      for (let el = target instanceof Element ? target : null; el && el !== document.body; el = el.parentElement) {
        const { overflowY } = getComputedStyle(el);
        if ((overflowY === "auto" || overflowY === "scroll") && el.scrollTop > 0) return false;
      }
      return true;
    };

    const reset = () => {
      start = null;
      decided = false;
      if (distance !== 0) {
        distance = 0;
        setPull(0);
      }
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || !canStart(e.target)) {
        start = null;
        return;
      }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      decided = false;
    };

    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (!decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        // Sideways or upward first: not a pull. Let the gesture be.
        if (Math.abs(dx) > Math.abs(dy) || dy < 0) {
          start = null;
          return;
        }
        decided = true;
      }
      if (dy <= 0 || window.scrollY > 0) {
        reset();
        return;
      }
      distance = Math.min(MAX_PULL, dy * RESISTANCE);
      setPull(distance);
    };

    const onEnd = () => {
      if (!start) return;
      if (distance >= THRESHOLD) {
        setRefreshing(true);
        setPull(THRESHOLD);
        window.location.reload();
        return;
      }
      reset();
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, []);

  if (pull === 0 && !refreshing) return null;

  const progress = Math.min(1, pull / THRESHOLD);
  const armed = pull >= THRESHOLD;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[55] flex justify-center"
      // Just under the app bar (64px + the status-bar inset), sliding down with the finger.
      style={{ top: `calc(env(safe-area-inset-top, 0px) + 4rem + ${pull - 44}px)` }}
    >
      <div
        role="status"
        aria-live="polite"
        className={`flex h-10 w-10 items-center justify-center rounded-full shadow-lg shadow-black/40 transition-colors ${
          armed ? "bg-yellow-400 text-slate-900" : "bg-slate-100 text-slate-700"
        }`}
        style={{ opacity: 0.4 + progress * 0.6 }}
      >
        <span className="sr-only">{refreshing ? "Refreshing" : armed ? "Release to refresh" : "Pull to refresh"}</span>
        <svg
          viewBox="0 0 24 24"
          className={`h-5 w-5 ${refreshing ? "animate-spin" : ""}`}
          style={refreshing ? undefined : { transform: `rotate(${progress * 300}deg)` }}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 12a8 8 0 1 1-2.34-5.66" />
          <path d="M20 4v5h-5" />
        </svg>
      </div>
    </div>
  );
}
