"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const noopSubscribe = () => () => {};

/**
 * True once running in the browser. Portals need `document.body`, so overlays render nothing on
 * the server pass. `useSyncExternalStore` rather than a `setMounted(true)` effect: same result,
 * without the extra cascading render.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export interface ModalOverlayOptions {
  /** Whether the overlay is mounted. Behaviour attaches while true and detaches when it goes false. */
  active: boolean;
  onClose: () => void;
  /** The dialog panel. Tab is cycled inside it and it gets focus when nothing better is named. */
  panelRef: RefObject<HTMLElement | null>;
  /** Element to focus on open (e.g. the close button). Defaults to the panel itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The behaviour every modal surface (navigation drawer, bottom sheets) shares:
 * Escape to dismiss, background scroll lock, focus moved in on open and restored on close, and a
 * Tab trap so `aria-modal="true"` is honest for keyboard users.
 *
 * Background `inert` is deliberately not applied: overlays are portalled to `<body>`, and making
 * the app root inert would need a known root element. Keyboard is the common case.
 *
 * Returns the `onKeyDown` handler to put on the panel.
 */
export function useModalOverlay({ active, onClose, panelRef, initialFocusRef }: ModalOverlayOptions) {
  // Latest onClose without re-subscribing the document listener on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active]);

  // No scrollbar-width compensation: overlays are phone-first, where scrollbars overlay content.
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    (initialFocusRef?.current ?? panel)?.focus();
    return () => {
      // Only hand focus back if it is still inside the overlay (or lost to <body>) — a link that
      // navigated away should not have focus yanked back to the opener.
      const current = document.activeElement;
      if (!current || current === document.body || panel?.contains(current)) {
        previouslyFocused?.focus();
      }
    };
  }, [active, panelRef, initialFocusRef]);

  return useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [panelRef],
  );
}

/**
 * Mount/unmount bookkeeping for an overlay with enter and exit transitions.
 *
 * `open` is intent; `rendered` is presence. They diverge for `exitMs` after a close so the exit
 * transition can play. `shown` flips one frame after mount so the browser paints the off-screen
 * position first and the enter transition has something to animate from.
 *
 * `prefers-reduced-motion` removes the transitions (`motion-reduce:transition-none`), so exit
 * relies on the timer, never on `transitionend`.
 */
export function usePresence(open: boolean, exitMs = 250) {
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);

  // Adjusting state while rendering (React's documented alternative to an effect) — opening
  // mounts immediately.
  if (open && !rendered) setRendered(true);

  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    const t = setTimeout(() => {
      setRendered(false);
      setEntered(false);
    }, exitMs);
    return () => clearTimeout(t);
  }, [open, exitMs]);

  return { rendered: rendered || open, shown: open && entered };
}
