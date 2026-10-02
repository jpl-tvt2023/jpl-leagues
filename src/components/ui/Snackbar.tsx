"use client";

import type { ReactNode } from "react";

export interface SnackbarProps {
  open: boolean;
  message: ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}

/**
 * Android-style snackbar: a single line of status pinned to the bottom of the screen, above the
 * bottom navigation bar when there is one (`--app-bottom-offset`, set in globals.css), with at
 * most one action.
 */
export function Snackbar({ open, message, action, onDismiss }: SnackbarProps) {
  if (!open) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-3 bottom-[calc(var(--app-bottom-offset)+0.75rem)] z-[75] mx-auto flex max-w-md items-center gap-2 rounded-xl bg-slate-100 py-2 pl-4 pr-2 text-sm text-slate-900 shadow-2xl sm:inset-x-auto sm:right-6"
    >
      <span className="min-w-0 flex-1 py-1.5">{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="min-h-10 shrink-0 rounded-lg px-3 font-bold uppercase tracking-wide text-purple-700 transition hover:bg-purple-700/10 active:bg-purple-700/15"
        >
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-900/5 active:bg-slate-900/10"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}
