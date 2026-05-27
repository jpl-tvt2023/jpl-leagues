"use client";

import { useCallback, useEffect, useState } from "react";

interface FeedbackRow {
  id: string;
  scope: "site" | "league";
  leagueId: string | null;
  submitterTeamId: string;
  submitterName: string;
  subject: string | null;
  message: string;
  isImportant: boolean;
  resolvedAt: number | string | null;
  resolutionNote: string | null;
  createdAt: number | string;
  updatedAt: number | string;
}

interface FeedbackTabProps {
  endpoint: string;       // "/api/admin/<leagueId>/feedback" or "/api/superadmin/feedback"
  scopeLabel: string;     // "this league" or "site-wide"
}

function fmtDate(value: number | string | null | undefined): string {
  if (value == null) return "";
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

export function FeedbackTab({ endpoint, scopeLabel }: FeedbackTabProps) {
  const [rows, setRows] = useState<FeedbackRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(endpoint, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setRows(data.feedback ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load feedback");
      setRows([]);
    }
  }, [endpoint]);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const mutate = async (id: string, action: "toggle-important" | "toggle-resolved", resolutionNote?: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action, resolutionNote }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this feedback row? This cannot be undone.")) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/feedback/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  const markResolved = async (id: string, alreadyResolved: boolean) => {
    if (alreadyResolved) {
      await mutate(id, "toggle-resolved");
      return;
    }
    const note = prompt("Resolution note (optional, max 500 chars):") ?? undefined;
    await mutate(id, "toggle-resolved", note);
  };

  if (rows === null) {
    return <div className="text-gray-400 text-sm">Loading feedback…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Feedback ({scopeLabel})</h2>
          <p className="text-xs text-gray-400">{rows.length} row{rows.length === 1 ? "" : "s"}</p>
        </div>
        <button
          type="button"
          onClick={load}
          className="text-xs px-3 py-1 rounded-md bg-white/10 hover:bg-white/20 text-gray-200 transition"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-500/10 border border-red-500/30 text-red-300 px-3 py-2 text-sm">{error}</div>
      )}

      {rows.length === 0 && !error && (
        <div className="text-gray-400 text-sm italic">No feedback yet.</div>
      )}

      <ul className="space-y-3">
        {rows.map((r) => {
          const isExpanded = expanded.has(r.id);
          const isResolved = r.resolvedAt != null;
          return (
            <li
              key={r.id}
              className={`rounded-lg border p-4 ${
                r.isImportant
                  ? "border-yellow-400/40 bg-yellow-400/5"
                  : isResolved
                  ? "border-green-500/30 bg-green-500/5 opacity-80"
                  : "border-white/10 bg-white/5"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                    <span className="text-gray-200 font-semibold">{r.submitterName}</span>
                    <span>·</span>
                    <span>{fmtDate(r.createdAt)}</span>
                    {r.isImportant && (
                      <span className="px-2 py-0.5 rounded-full bg-yellow-400/20 text-yellow-300 text-[10px] font-semibold uppercase">Important</span>
                    )}
                    {isResolved && (
                      <span className="px-2 py-0.5 rounded-full bg-green-500/20 text-green-300 text-[10px] font-semibold uppercase">Resolved</span>
                    )}
                  </div>
                  {r.subject && (
                    <div className="mt-1 text-sm font-semibold text-white">{r.subject}</div>
                  )}
                  <div
                    className={`mt-1 text-sm text-gray-200 whitespace-pre-wrap ${isExpanded ? "" : "line-clamp-3"}`}
                    onClick={() => toggleExpand(r.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggleExpand(r.id); }}
                  >
                    {r.message}
                  </div>
                  {isResolved && r.resolutionNote && (
                    <div className="mt-2 text-xs text-green-300/80 italic">
                      Resolution: {r.resolutionNote}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => mutate(r.id, "toggle-important")}
                    className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-gray-200 transition disabled:opacity-50"
                  >
                    {r.isImportant ? "Unflag" : "Flag important"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => markResolved(r.id, isResolved)}
                    className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-gray-200 transition disabled:opacity-50"
                  >
                    {isResolved ? "Reopen" : "Mark resolved"}
                  </button>
                  <button
                    type="button"
                    disabled={busy === r.id}
                    onClick={() => remove(r.id)}
                    className="text-xs px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 text-red-300 transition disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
