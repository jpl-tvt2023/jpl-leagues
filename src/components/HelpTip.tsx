"use client";

import { useId, useRef, useState, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * HelpTip — a small, reusable styled tooltip for first-time-user help on labels, table headers, and
 * column abbreviations. The bubble is portalled to <body> and viewport-clamped so table `overflow`
 * can't clip it. Triggers on hover AND keyboard focus for accessibility.
 *
 * Usage:
 *   <HelpTip tip="Total league points across all gameweeks.">Pts</HelpTip>
 *   <HelpTip tip="…" label="Syn" />     // renders the label + a subtle ⓘ
 *
 * For buttons and inputs, prefer the native `title=` attribute instead of this component.
 */
export function HelpTip({
  tip,
  children,
  label,
  className = "",
}: {
  /** The help text shown on hover/focus. */
  tip: ReactNode;
  /** Content to wrap (the label/header text). Ignored if `label` is provided. */
  children?: ReactNode;
  /** Convenience: render this text plus a small ⓘ glyph as the trigger. */
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      if (!t) return;
      const bubbleW = bubbleRef.current?.offsetWidth ?? 240;
      const bubbleH = bubbleRef.current?.offsetHeight ?? 0;
      // Prefer below the trigger; flip above if it would overflow the viewport bottom.
      const below = t.bottom + 8;
      const above = t.top - 8 - bubbleH;
      const top = below + bubbleH > window.innerHeight - 8 && above > 8 ? above : below;
      // Center horizontally on the trigger, clamped to stay fully on-screen.
      const rawLeft = t.left + t.width / 2 - bubbleW / 2;
      const left = Math.max(8, Math.min(rawLeft, window.innerWidth - bubbleW - 8));
      setPos({ top, left });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <span
      ref={triggerRef}
      tabIndex={0}
      aria-describedby={open ? titleId : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      className={`cursor-help underline decoration-dotted decoration-gray-500 underline-offset-2 outline-none focus-visible:decoration-yellow-400 ${className}`}
    >
      {label ? (
        <span className="inline-flex items-center gap-0.5">
          {label}
          <span className="text-[0.85em] text-gray-500" aria-hidden>ⓘ</span>
        </span>
      ) : (
        children
      )}
      {open &&
        pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={bubbleRef}
            id={titleId}
            role="tooltip"
            className="fixed z-[80] max-w-[260px] rounded-lg border border-white/15 bg-slate-800/95 px-3 py-2 text-xs font-normal normal-case tracking-normal text-gray-200 shadow-xl backdrop-blur-md pointer-events-none"
            style={{ top: pos.top, left: pos.left }}
          >
            {tip}
          </div>,
          document.body
        )}
    </span>
  );
}
