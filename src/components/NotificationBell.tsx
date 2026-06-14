"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The bell sits inside nav containers that use `overflow-x-auto`, which
  // implicitly clips Y too. An absolute dropdown extending below the nav row
  // forces vertical overflow → Chromium renders a thin vertical scrollbar in
  // the nav. Using `position: fixed` escapes that overflow container; we just
  // need to pin the dropdown to the bell button's rect when it opens.
  const dropdownRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Right-anchor to the bell, but clamp so a wide (92vw) panel can never overflow the left edge
      // when the bell sits mid-nav on a narrow screen. Max `right` keeps `left` >= 8px.
      const width = dropdownRef.current?.offsetWidth ?? Math.min(window.innerWidth * 0.92, 384);
      const desiredRight = window.innerWidth - rect.right;
      const maxRight = Math.max(8, window.innerWidth - width - 8);
      setDropdownPos({
        top: rect.bottom + 8,
        right: Math.min(Math.max(8, desiredRight), maxRight),
      });
    };
    update();
    // Re-run once after the panel has mounted so we can measure its real width and re-clamp.
    const raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

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
    // Only flip local state if the server confirms persistence. Without this check, a 500/network
    // error would leave the badge showing "read" while the DB row stays unread — and the next
    // refresh would tick the badge count back up, confusing the user.
    try {
      const res = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        console.error("[NotificationBell] markRead failed:", res.status);
        return;
      }
      setItems((prev) => prev.map((n) => (ids.includes(n.id) && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
      setUnread((u) => Math.max(0, u - ids.length));
    } catch (e) {
      console.error("[NotificationBell] markRead network error:", e);
    }
  }

  async function markAll() {
    try {
      const res = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) {
        console.error("[NotificationBell] markAll failed:", res.status);
        return;
      }
      setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
      setUnread(0);
    } catch (e) {
      console.error("[NotificationBell] markAll network error:", e);
    }
  }

  function handleClick(n: NotificationItem) {
    if (!n.readAt) markRead([n.id]);
    if (n.link) router.push(n.link);
    setOpen(false);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        ref={buttonRef}
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
        <div
          ref={dropdownRef}
          className="fixed w-[92vw] max-w-sm sm:w-80 max-h-[70vh] sm:max-h-96 overflow-y-auto overflow-x-hidden rounded-lg border border-white/10 bg-slate-900 shadow-xl z-[60]"
          style={dropdownPos ? { top: dropdownPos.top, right: dropdownPos.right } : { top: -9999, right: 0 }}
        >
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
            <>
              <ul className="divide-y divide-white/5">
                {items.slice(0, 3).map((n) => (
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
                          <div className="text-sm font-semibold text-white break-words">{n.title}</div>
                          <div className="text-xs text-gray-300 mt-0.5 break-words">{n.body}</div>
                          <div className="text-[10px] text-gray-500 mt-1">{new Date(n.createdAt).toLocaleString()}</div>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="border-t border-white/10 px-3 py-2 text-center">
                <button
                  onClick={() => { setOpen(false); window.location.href = "/notifications"; }}
                  className="text-xs text-yellow-400 hover:text-yellow-300 font-semibold"
                >
                  See all notifications →
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
