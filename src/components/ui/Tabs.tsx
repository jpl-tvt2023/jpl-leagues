"use client";

import { useState, type ReactNode } from "react";
import { Sheet } from "./Sheet";
import { NavIcon } from "@/components/icons/NavIcon";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Plain-text label for the phone section picker when `label` is rich. */
  text?: string;
  /** Small count/status chip after the label. */
  badge?: ReactNode;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Names the tab list for assistive tech, and titles the phone section picker. */
  ariaLabel: string;
  /** `underline` — Material fixed tabs. `pill` — a segmented control on a tinted track. */
  variant?: "underline" | "pill";
  /**
   * Classes for the selected tab. Defaults: underline — yellow label and indicator; pill — a
   * yellow segment with dark text.
   */
  accentClass?: string;
  className?: string;
}

/** More tabs than this and a phone gets a section picker instead of a squeezed row. */
const MAX_PHONE_TABS = 4;

/**
 * Tab bar that never scrolls sideways.
 *
 * Up to four tabs render as Material **fixed tabs**: equal widths across the full row, so they
 * always fit a phone. With more tabs, phones get a single "Section ▾" control that opens a bottom
 * sheet listing them, and wider screens let the row wrap.
 *
 * Tabs are plain `<button>`s with `aria-pressed`, matching the ad-hoc tab rows this replaces, so
 * existing `getByRole("button", { name })` selectors keep working.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  variant = "underline",
  accentClass,
  className = "",
}: TabsProps<T>) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const active = items.find((i) => i.id === value) ?? items[0];
  const many = items.length > MAX_PHONE_TABS;

  const selectedClass =
    accentClass ?? (variant === "pill" ? "bg-yellow-500 text-slate-900 shadow" : "text-yellow-400 border-yellow-400");

  const tabClass = (selected: boolean) => {
    if (variant === "pill") {
      return `min-h-10 rounded-lg px-3 py-2 text-xs sm:text-sm font-semibold transition ${
        selected ? selectedClass : "text-gray-400 hover:text-white active:bg-white/10"
      }`;
    }
    return `min-h-12 border-b-2 px-3 text-sm font-semibold transition ${
      selected ? selectedClass : "border-transparent text-gray-400 hover:text-white active:bg-white/5"
    }`;
  };

  const row = (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`${many ? "hidden sm:flex flex-wrap" : "flex"} ${
        variant === "pill" ? "gap-1 rounded-xl bg-slate-800/60 p-1" : "border-b border-white/10"
      }`}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(item.id)}
            className={`${many ? "" : "min-w-0 flex-1"} ${tabClass(selected)}`}
          >
            <span className="inline-flex max-w-full items-center justify-center gap-1.5">
              <span className={many ? "whitespace-nowrap" : "truncate"}>{item.label}</span>
              {item.badge}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={className}>
      {row}
      {many && (
        <>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            aria-haspopup="dialog"
            className="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-4 text-left text-sm font-semibold text-white transition active:bg-white/10 sm:hidden"
          >
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-widest text-gray-500">{ariaLabel}</span>
              <span className="flex items-center gap-1.5 truncate">
                {active?.label}
                {active?.badge}
              </span>
            </span>
            <NavIcon name="chevron-down" className="h-5 w-5 shrink-0 text-gray-400" />
          </button>
          <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title={ariaLabel} size="sm">
            <ul className="-mx-2">
              {items.map((item) => {
                const selected = item.id === value;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(item.id);
                        setPickerOpen(false);
                      }}
                      className={`flex min-h-12 w-full items-center gap-3 rounded-full px-4 text-left text-sm transition active:bg-white/15 ${
                        selected ? "bg-white/10 font-semibold text-white" : "text-gray-300 hover:bg-white/5"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{item.text ?? item.label}</span>
                      {item.badge}
                      {selected && <NavIcon name="check" className="h-5 w-5 shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Sheet>
        </>
      )}
    </div>
  );
}
