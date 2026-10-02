"use client";

import { useId, useState, type ReactNode } from "react";
import { NavIcon } from "@/components/icons/NavIcon";

/*
 * Phone-friendly tables — the pattern every wide table in the app follows:
 *
 *  1. Fold. A secondary column gets `hidden sm:table-cell` on its <th>/<td>, and its value moves to
 *     a `sm:hidden` sub-line under the name cell (see FplLeagueTable's ManagerRow). Cheap, and the
 *     row stays one tap target.
 *  2. Expand. When a table has more numbers than fit even after folding (auction standings,
 *     gameweek results), hide them below `sm` and render each row as an `ExpandableRow`: tapping
 *     it reveals a full-width detail row listing the hidden stats as label/value pairs.
 *  3. Never set `min-w-[…px]` on a table. A table that needs one is a table that scrolls sideways
 *     on a phone; `tests/smoke/mobile-layout.spec.ts` fails on any such scroller.
 */

export interface DetailItem {
  label: ReactNode;
  value: ReactNode;
}

/** Label/value pairs for an expanded row's detail panel. */
export function DetailGrid({ items }: { items: DetailItem[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
      {items.map((item, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[10px] uppercase tracking-wider text-gray-500">{item.label}</dt>
          <dd className="truncate font-semibold text-gray-100">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The header cell matching `ExpandableRow`'s chevron column. Renders only below `sm`. */
export function ExpandHeaderCell({ className = "" }: { className?: string }) {
  return (
    <th className={`w-8 sm:hidden ${className}`}>
      <span className="sr-only">Details</span>
    </th>
  );
}

export interface ExpandableRowProps {
  children: ReactNode;
  /** Shown in a full-width row under this one when expanded (phones only). */
  details: ReactNode;
  /** Columns the detail row spans — the table's full column count at phone width. */
  colSpan: number;
  className?: string;
  /** Classes for the detail row's cell (match the table's row tint). */
  detailClassName?: string;
}

/**
 * A table row that, below `sm`, toggles a detail row revealing the columns hidden at phone
 * width. From `sm` up those columns are visible, so the chevron column and the detail row are
 * hidden and the row behaves like any other.
 */
export function ExpandableRow({ children, details, colSpan, className = "", detailClassName = "" }: ExpandableRowProps) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <>
      <tr className={`${className} cursor-pointer sm:cursor-auto`} onClick={() => setOpen((o) => !o)}>
        {children}
        <td className="w-8 pr-2 text-right sm:hidden">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={open ? "Hide details" : "Show details"}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition active:bg-white/10"
          >
            <NavIcon
              name="chevron-down"
              className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            />
          </button>
        </td>
      </tr>
      {open && (
        <tr id={detailId} className="sm:hidden">
          <td colSpan={colSpan} className={`border-b border-white/5 bg-black/20 px-3 py-3 ${detailClassName}`}>
            {details}
          </td>
        </tr>
      )}
    </>
  );
}
