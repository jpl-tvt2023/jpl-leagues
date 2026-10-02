"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, kept in sync as the window resizes.
 *
 * For behaviour that CSS alone cannot express — e.g. "only fetch the stats once they are
 * actually on screen", where visibility depends on the breakpoint. Layout itself should stay in
 * Tailwind classes. False on the server and on the first client render, so markup hydrates
 * identically; it updates right after.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
