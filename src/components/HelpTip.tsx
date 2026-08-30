"use client";

import { useEffect, useId, useRef, useState, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * HelpTip — a small, reusable styled tooltip for first-time-user help on labels, table headers, and
 * column abbreviations. The bubble is portalled to <body> and viewport-clamped so table `overflow`
 * can't clip it.
 *
 * Opens on hover (mouse only), on keyboard focus, and on tap. The tap path is deliberate rather
 * than incidental: this used to rely on `tabIndex` + `onFocus`, which does NOT work on touch —
 * iOS Safari routinely leaves focus on <body> after tapping a non-interactive span, and it gates
 * the synthetic `mouseenter` on the element looking interactive, which a span with no click
 * handler does not. A tooltip that only opens on hover is invisible on a phone.
 *
 * Usage:
 *   <HelpTip tip="Total league points across all gameweeks.">Pts</HelpTip>
 *   <HelpTip tip="…" label="Syn" />     // renders the label + a subtle ⓘ
 *   <HelpTip tip={<RichPanel />} wide />  // for content wider than a sentence
 *
 * For buttons and inputs, prefer the native `title=` attribute instead of this component.
 */
export function HelpTip({
  tip,
  children,
  label,
  className = "",
  wide = false,
}: {
  /** The help text shown on hover/focus/tap. */
  tip: ReactNode;
  /** Content to wrap (the label/header text). Ignored if `label` is provided. */
  children?: ReactNode;
  /** Convenience: render this text plus a small ⓘ glyph as the trigger. */
  label?: string;
  className?: string;
  /**
   * Widen the bubble for rich content (a table, a score breakdown) that cannot read at the
   * default sentence width. Off by default so existing text tooltips are unchanged.
   */
  wide?: boolean;
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

  // A tap-opened tooltip has no mouseleave to close it, so it needs explicit dismissal.
  // The bubble is `pointer-events-none`, so a tap landing on it passes through to whatever
  // is underneath — no bubble-exclusion check is needed here.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <span
      ref={triggerRef}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-describedby={open ? titleId : undefined}
      // Hover is mouse-only. Without the pointerType guard, Android fires a synthetic
      // pointerenter that opens the tip and then a click that immediately toggles it shut.
      onPointerEnter={(e) => { if (e.pointerType === "mouse") setOpen(true); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") setOpen(false); }}
      // Toggle on touch/pen only. On a mouse, hover already governs the tooltip, and toggling
      // here would close the tip that the pointerenter above just opened — a click would then
      // read as "nothing happens".
      onPointerUp={(e) => { if (e.pointerType !== "mouse") setOpen((v) => !v); }}
      onClick={(e) => {
        // Several call sites sit inside a clickable card; opening a tooltip must not also
        // trigger the parent's action.
        e.stopPropagation();
      }}
      // Keyboard only. A plain onFocus would re-open the tip that the click above just closed,
      // because clicking also focuses the trigger.
      onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setOpen(true); }}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen((v) => !v);
        }
      }}
      style={{ touchAction: "manipulation" }}
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
            className={`fixed z-[80] ${wide ? "max-w-[min(92vw,420px)]" : "max-w-[260px]"} rounded-lg border border-white/15 bg-slate-800/95 px-3 py-2 text-xs font-normal normal-case tracking-normal text-gray-200 shadow-xl backdrop-blur-md pointer-events-none`}
            style={{ top: pos.top, left: pos.left }}
          >
            {tip}
          </div>,
          document.body
        )}
    </span>
  );
}
