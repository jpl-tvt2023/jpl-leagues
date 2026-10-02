"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsClient, useModalOverlay, usePresence } from "@/hooks/useModalOverlay";

const EXIT_MS = 250;
/** Drag distance (px) past which releasing the handle dismisses the sheet. */
const DISMISS_DRAG_PX = 96;

const WIDTHS = {
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-lg",
  xl: "sm:max-w-xl",
  "2xl": "sm:max-w-2xl",
  "3xl": "sm:max-w-3xl",
} as const;

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Optional line under the title. */
  description?: ReactNode;
  children: ReactNode;
  /** Pinned below the scrolling body — primary/secondary actions go here. */
  footer?: ReactNode;
  /** Width of the centred dialog at `sm` and up. Phones always get a full-width sheet. */
  size?: keyof typeof WIDTHS;
  /** Hide the × button (e.g. a sheet whose footer already has a Cancel). */
  hideClose?: boolean;
}

/**
 * The app's one modal surface.
 *
 * Phones get an Android-style **bottom sheet**: it slides up from the bottom edge, has a drag
 * handle and can be swiped down to dismiss, and never exceeds 90% of the viewport height (the
 * body scrolls instead). From `sm` up it is an ordinary centred dialog.
 *
 * Portalled to `<body>` so no ancestor's `overflow` or `backdrop-blur` stacking context can clip
 * it. Escape, scrim tap, scroll lock and focus trapping come from `useModalOverlay`.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "lg",
  hideClose = false,
}: SheetProps) {
  const isClient = useIsClient();
  const { rendered, shown } = usePresence(open, EXIT_MS);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onKeyDown = useModalOverlay({ active: rendered, onClose, panelRef });

  const [drag, setDrag] = useState<{ startY: number; dy: number } | null>(null);

  if (!isClient || !rendered) return null;

  const onTouchStart = (e: React.TouchEvent) => setDrag({ startY: e.touches[0].clientY, dy: 0 });
  const onTouchMove = (e: React.TouchEvent) => {
    if (!drag) return;
    setDrag({ ...drag, dy: Math.max(0, e.touches[0].clientY - drag.startY) });
  };
  const onTouchEnd = () => {
    if (drag && drag.dy > DISMISS_DRAG_PX) onClose();
    setDrag(null);
  };

  const dragging = drag !== null && drag.dy > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none ${
          shown ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={dragging ? { transform: `translateY(${drag.dy}px)`, transition: "none" } : undefined}
        className={`relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-slate-900 shadow-2xl outline-none transition duration-200 ease-out motion-reduce:transition-none sm:rounded-2xl ${WIDTHS[size]} ${
          shown
            ? "translate-y-0 sm:opacity-100"
            : "translate-y-full sm:translate-y-4 sm:opacity-0"
        }`}
      >
        {/* Drag handle + header. The whole strip is the drag target so a thumb doesn't have to
            find the 4px pill; the body below keeps native scrolling. */}
        <div
          className="shrink-0 touch-none sm:touch-auto"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <div className="flex justify-center pt-3 sm:hidden" aria-hidden="true">
            <span className="h-1 w-10 rounded-full bg-white/25" />
          </div>
          <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-3 sm:px-6 sm:pt-5">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-bold leading-snug text-white">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-gray-400">
                  {description}
                </p>
              )}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-2 -mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-gray-400 transition hover:bg-white/10 hover:text-white active:bg-white/15"
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 sm:px-6">{children}</div>

        {footer && (
          <div className="shrink-0 border-t border-white/10 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4">
            {footer}
          </div>
        )}
        {!footer && <div className="shrink-0 pb-[env(safe-area-inset-bottom)] sm:hidden" aria-hidden="true" />}
      </div>
    </div>,
    document.body,
  );
}
