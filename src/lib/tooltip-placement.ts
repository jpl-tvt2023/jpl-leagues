/**
 * Where a tooltip bubble goes, given its trigger and the viewport.
 *
 * Pure, so the geometry can be unit-tested without a DOM (tests/unit/tooltip-placement.test.ts).
 * HelpTip measures the trigger and the bubble, then hands the numbers here.
 *
 * The one guarantee: the bubble never leaves the viewport. When the content is taller than the
 * room on either side of the trigger, it takes the roomier side and gets a `maxHeight`, and the
 * bubble scrolls internally rather than running off the bottom of a phone screen.
 */

export interface TooltipPlacementInput {
  /** The trigger's bounding rect, in viewport coordinates. */
  trigger: { top: number; bottom: number; left: number; width: number };
  /** The bubble's rendered width (already clamped to the viewport by the caller). */
  bubbleWidth: number;
  /** The bubble's full content height — scrollHeight, not the possibly-capped offsetHeight. */
  naturalHeight: number;
  viewport: { width: number; height: number };
  /** Minimum distance kept from every viewport edge. */
  margin?: number;
  /** Distance between the trigger and the bubble. */
  gap?: number;
}

export interface TooltipPlacement {
  top: number;
  left: number;
  /** Set only when the content does not fit; the bubble must then scroll. */
  maxHeight: number | null;
}

export function placeTooltip({
  trigger,
  bubbleWidth,
  naturalHeight,
  viewport,
  margin = 8,
  gap = 8,
}: TooltipPlacementInput): TooltipPlacement {
  const spaceBelow = Math.max(0, viewport.height - margin - (trigger.bottom + gap));
  const spaceAbove = Math.max(0, trigger.top - gap - margin);

  let top: number;
  let maxHeight: number | null = null;
  if (naturalHeight <= spaceBelow) {
    top = trigger.bottom + gap;
  } else if (naturalHeight <= spaceAbove) {
    top = trigger.top - gap - naturalHeight;
  } else if (spaceBelow >= spaceAbove) {
    top = trigger.bottom + gap;
    maxHeight = spaceBelow;
  } else {
    maxHeight = spaceAbove;
    top = trigger.top - gap - spaceAbove;
  }

  // A trigger partly scrolled under an edge can still push the result out; pin it back in.
  const height = maxHeight ?? naturalHeight;
  top = Math.max(margin, Math.min(top, viewport.height - margin - height));

  const rawLeft = trigger.left + trigger.width / 2 - bubbleWidth / 2;
  const left = Math.max(margin, Math.min(rawLeft, viewport.width - bubbleWidth - margin));

  return { top, left, maxHeight };
}
