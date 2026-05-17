"use client";

import { useEffect, useRef, useState } from "react";

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export function NotificationBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/notifications");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setItems(data.notifications ?? []);
        setUnread(data.unreadCount ?? 0);
      } catch {
        // ignore
      }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function markRead(ids: string[]) {
    if (ids.length === 0) return;
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    setItems((prev) => prev.map((n) => (ids.includes(n.id) && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnread((u) => Math.max(0, u - ids.length));
  }

  async function markAll() {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnread(0);
  }

  function handleClick(n: NotificationItem) {
    if (!n.readAt) markRead([n.id]);
    if (n.link) window.location.href = n.link;
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-full bg-white/10 p-2 text-white hover:bg-white/20 transition"
        aria-label="Notifications"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-0 right-0 h-[18px] min-w-[18px] rounded-full bg-red-500 text-[10px] font-bold text-white flex items-center justify-center px-1 ring-2 ring-slate-900">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[92vw] max-w-sm sm:w-80 max-h-[70vh] sm:max-h-96 overflow-y-auto rounded-lg border border-white/10 bg-slate-900 shadow-xl z-50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
            <span className="text-sm font-semibold text-white">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-yellow-400 hover:text-yellow-300">
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-8 flex flex-col items-center text-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-8 w-8 text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M3 3l18 18"
                />
              </svg>
              <div className="text-sm font-semibold text-white">You&apos;re all caught up</div>
              <p className="text-xs text-gray-400 leading-relaxed max-w-[260px]">
                We&apos;ll ping you when a gameweek is scored, a trade lands, or your purse changes.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => handleClick(n)}
                    className={`w-full text-left px-3 py-2 hover:bg-white/5 transition ${
                      n.readAt ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-yellow-400" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-white">{n.title}</div>
                        <div className="text-xs text-gray-300 mt-0.5">{n.body}</div>
                        <div className="text-[10px] text-gray-500 mt-1">{new Date(n.createdAt).toLocaleString()}</div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
