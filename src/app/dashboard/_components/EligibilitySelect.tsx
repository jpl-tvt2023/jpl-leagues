"use client";

// A small custom listbox that always shows every option, disabling
// (rather than hiding) whichever ones aren't currently usable, with a
// native hover tooltip explaining why.
//
// Native <option disabled title="..."> tooltips are unreliable across
// browsers (Chrome shows them, Firefox/Safari don't consistently) — a
// <button title="..."> row shows a hover tooltip reliably everywhere, which
// is the whole reason this exists instead of a plain <select>.

import { useEffect, useRef, useState } from "react";

export interface EligibilityOption {
  value: string;
  label: string;
  disabled: boolean;
  reason?: string | null;
}

interface EligibilitySelectProps {
  options: EligibilityOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  accentClass?: string; // e.g. "focus:border-yellow-400" to match the picker it replaces
}

export function EligibilitySelect({
  options,
  value,
  onChange,
  disabled,
  placeholder,
  accentClass = "focus:border-yellow-400",
}: EligibilitySelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const selected = options.find(o => o.value === value);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        className={`w-full p-2 rounded-lg bg-slate-800 text-white border border-white/30 text-left flex items-center justify-between gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${accentClass}`}
      >
        <span className={selected ? "" : "text-gray-400"}>{selected ? selected.label : placeholder}</span>
        <span className="text-gray-400 text-xs">▾</span>
      </button>
      {open && !disabled && (
        <div className="absolute z-20 mt-1 w-full rounded-lg bg-slate-800 border border-white/30 shadow-lg overflow-hidden">
          <button
            type="button"
            onClick={() => { onChange(""); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm text-gray-400 hover:bg-white/10"
          >
            {placeholder}
          </button>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              title={opt.disabled ? (opt.reason ?? undefined) : undefined}
              onClick={() => {
                if (opt.disabled) return;
                onChange(opt.value);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm ${
                opt.disabled
                  ? "text-gray-500 cursor-not-allowed"
                  : opt.value === value
                    ? "text-yellow-400 bg-white/5 hover:bg-white/10"
                    : "text-white hover:bg-white/10"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
