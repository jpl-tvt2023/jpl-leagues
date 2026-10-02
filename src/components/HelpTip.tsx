"use client";

import { useEffect, useId, useRef, useState, useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeTooltip, type TooltipPlacement } from "@/lib/tooltip-placement";

/** How long a mouse may spend crossing the gap from the trigger into the bubble. */
const HOVER_CLOSE_MS = 120;

/**
 * HelpTip — the app's one tooltip: help on labels, table headers and column abbreviations, and
 * rich breakdowns (a challenge match, a CP/BP tally, a club's results by gameweek).
 *
 * The bubble is portalled to <body> so no table `overflow` or `backdrop-blur` stacking context can
 * clip it, and it always fits the viewport: its width is clamped to the screen, it opens on
 * whichever side of the trigger has room, and when the content is taller than either side it
 * caps its height and scrolls internally. See src/lib/tooltip-placement.ts.
 *
 * Opens on hover (mouse only), on keyboard focus, and on tap. The tap path is deliberate rather
 * than incidental: this used to rely on `tabIndex` + `onFocus`, which does NOT work on touch —
 * iOS Safari routinely leaves focus on <body> after tapping a non-interactive span, and it gates
 * the synthetic `mouseenter` on the element looking interactive, which a span with no click
 * handler does not. A tooltip that only opens on hover is invisible on a phone.
 *
 * The bubble takes pointer events, because a capped bubble must be scrollable by touch and wheel.
 * A tap inside it therefore keeps it open; a tap anywhere else, or Escape, closes it.
 *
 * Usage:
 *   <HelpTip tip="Total league points across all gameweeks.">Pts</HelpTip>
 *   <HelpTip tip="…" label="Syn" />              // renders the label + a subtle ⓘ
 *   <HelpTip tip={<RichPanel />} width={420} />  // for content wider than a sentence
 *
 * For buttons and inputs, prefer the native `title=` attribute instead of this component.
 */
export function HelpTip({
  tip,
  children,
  label,
  className = "",
  width,
  as: Tag = "span",
}: {
  /** The help text shown on hover/focus/tap. */
  tip: ReactNode;
  /** Content to wrap (the label/header text). Ignored if `label` is provided. */
  children?: ReactNode;
  /** Convenience: render this text plus a small ⓘ glyph as the trigger. */
  label?: string;
  className?: string;
  /**
   * Fixed bubble width in px, for rich content (a table, a score breakdown) that cannot read at
   * sentence width. Always clamped to the screen minus an 8px gutter each side. Omit it for a
   * text tip, which shrinks to fit up to 260px.
   *
   * The width belongs on the bubble, never on the content: content given its own viewport-based
   * width cannot account for the bubble's padding and border, and spills out of it on a phone.
   */
  width?: number;
  /** "div" for a block-level trigger (a whole card), so a <div> is not nested in a <span>. */
  as?: "span" | "div";
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const titleId = useId();

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    []
  );

  const inBubble = (target: EventTarget | null) =>
    !!target && !!bubbleRef.current?.contains(target as Node);

  // Runs before paint: the bubble mounts hidden at 0,0, is measured here, and is only revealed
  // once placed — so it never flashes at a guessed size or on the wrong side of the trigger.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const bubble = bubbleRef.current;
      if (!trigger || !bubble) return;
      const next = placeTooltip({
        trigger: trigger.getBoundingClientRect(),
        bubbleWidth: bubble.offsetWidth,
        // scrollHeight is the full content height even while a previous maxHeight caps the box;
        // the offset/client difference adds the border back.
        naturalHeight: bubble.scrollHeight + (bubble.offsetHeight - bubble.clientHeight),
        // clientWidth, not innerWidth: a desktop scrollbar is not room the bubble can use.
        viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
      });
      setPlacement((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight
          ? prev
          : next
      );
    };
    // A bubble left pinned to the screen edge after its trigger has scrolled away points at
    // nothing; close it instead.
    const onScroll = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      if (t && (t.bottom < 0 || t.top > window.innerHeight)) {
        setOpen(false);
        return;
      }
      place();
    };
    place();
    // Content can change size while open — a live challenge rescoring, a font finishing loading.
    // Re-placed on the next frame, not inside the observer callback: capping the height can add a
    // scrollbar that narrows the observed content, which inside the callback is a ResizeObserver
    // loop error.
    let raf = 0;
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(place);
          })
        : null;
    if (observer && contentRef.current) observer.observe(contentRef.current);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
      setPlacement(null);
    };
  }, [open]);

  // A tap-opened tooltip has no mouseleave to close it, so it needs explicit dismissal. Taps on
  // the bubble itself are excluded: they are how a capped bubble gets scrolled.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || bubbleRef.current?.contains(target)) return;
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

  // Every handler below also receives events from inside the bubble: it is portalled, but React
  // still bubbles its events through this trigger. Hence the `inBubble` checks.
  return (
    <Tag
      ref={triggerRef as React.RefObject<HTMLDivElement & HTMLSpanElement>}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-describedby={open ? titleId : undefined}
      // Hover is mouse-only. Without the pointerType guard, Android fires a synthetic
      // pointerenter that opens the tip and then a click that immediately toggles it shut.
      // React counts the portalled bubble as a child of this trigger, so moving the mouse into
      // the bubble re-fires this enter and cancels the close scheduled by the leave below.
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") {
          cancelClose();
          setOpen(true);
        }
      }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse") scheduleClose(); }}
      // Toggle on touch/pen only. On a mouse, hover already governs the tooltip, and toggling
      // here would close the tip that the pointerenter above just opened — a click would then
      // read as "nothing happens". A tap inside the bubble must not toggle it shut either.
      onPointerUp={(e) => {
        if (e.pointerType !== "mouse" && !inBubble(e.target)) setOpen((v) => !v);
      }}
      onClick={(e) => {
        // Several call sites sit inside a clickable card; opening a tooltip (or tapping inside
        // its bubble) must not also trigger the parent's action.
        e.stopPropagation();
      }}
      // Keyboard only. A plain onFocus would re-open the tip that the click above just closed,
      // because clicking also focuses the trigger.
      onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setOpen(true); }}
      // Focus moving into the bubble (a tap or click on it) is not leaving the tooltip.
      onBlur={(e) => {
        if (inBubble(e.relatedTarget) || triggerRef.current?.contains(e.relatedTarget as Node)) return;
        setOpen(false);
      }}
      onKeyDown={(e) => {
        if (inBubble(e.target)) return;
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
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={bubbleRef}
            id={titleId}
            role="tooltip"
            // Focusable so that tapping inside moves focus here, which onBlur above recognises,
            // rather than to <body>, which it would read as leaving.
            tabIndex={-1}
            className="fixed z-[80] overflow-y-auto overscroll-contain rounded-lg border border-white/15 bg-slate-800/95 px-3 py-2 text-left text-xs font-normal normal-case tracking-normal text-gray-200 shadow-xl outline-none backdrop-blur-md"
            style={{
              top: placement?.top ?? 0,
              left: placement?.left ?? 0,
              // Percentages on a fixed box resolve against the viewport excluding its scrollbar.
              width: width ? `min(${width}px, calc(100% - 16px))` : undefined,
              maxWidth: width ? undefined : "min(260px, calc(100% - 16px))",
              maxHeight: placement?.maxHeight ?? undefined,
              visibility: placement ? undefined : "hidden",
            }}
          >
            <div ref={contentRef}>{tip}</div>
          </div>,
          document.body
        )}
    </Tag>
  );
}
