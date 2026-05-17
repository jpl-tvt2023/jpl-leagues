"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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

const PAGE_SIZE = 50;

export default function NotificationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const res = await fetch(`/api/notifications?page=${page}&pageSize=${PAGE_SIZE}`);
        if (!res.ok) {
          if (res.status === 401) {
            router.push("/signin");
            return;
          }
          throw new Error("Failed to fetch notifications");
        }
        const data = await res.json();
        if (cancelled) return;
        setItems(data.notifications ?? []);
        setUnread(data.unreadCount ?? 0);
        setTotalCount(data.totalCount ?? 0);
        setTotalPages(data.totalPages ?? 0);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [router, page]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const markAll = async () => {
    await fetch("/api/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnread(0);
  };

  const handleClick = async (n: NotificationItem) => {
    if (!n.readAt) {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [n.id] }),
      });
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnread((u) => Math.max(0, u - 1));
    }
    if (n.link) window.location.href = n.link;
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <nav className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-2 px-3 py-2 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10 bg-slate-900/80 backdrop-blur">
        <Link href="/dashboard" className="flex items-center gap-2 shrink-0">
          <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center text-xs sm:text-base font-bold text-slate-900">
            JPL
          </div>
          <span className="text-base sm:text-xl font-bold text-white">Notifications</span>
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="text-sm text-gray-300 hover:text-white transition">
            ← Back to Dashboard
          </Link>
          <button
            onClick={handleSignOut}
            className="rounded-full bg-white/10 px-4 sm:px-6 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-white hover:bg-white/20 transition"
          >
            Sign Out
          </button>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">Notifications</h1>
            <p className="text-sm text-gray-400 mt-1">
              {totalCount} total {unread > 0 && <span className="text-yellow-400">· {unread} unread</span>}
            </p>
          </div>
          {unread > 0 && (
            <button
              onClick={markAll}
              className="text-sm text-yellow-400 hover:text-yellow-300 font-semibold"
            >
              Mark all as read
            </button>
          )}
        </div>

        {isLoading ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center text-gray-400">
            Loading notifications…
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center text-red-300">
            {error}
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-12 flex flex-col items-center text-center gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-12 w-12 text-gray-500"
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
            <div className="text-lg font-semibold text-white">You&apos;re all caught up</div>
            <p className="text-sm text-gray-400 max-w-md">
              We&apos;ll ping you when a gameweek is scored, a trade lands, or your purse changes.
            </p>
          </div>
        ) : (
          <>
            <ul className="rounded-2xl border border-white/10 bg-white/5 overflow-hidden divide-y divide-white/5">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => handleClick(n)}
                    className={`w-full text-left px-4 py-4 hover:bg-white/[0.04] transition ${
                      n.readAt ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {!n.readAt && (
                        <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-yellow-400" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-3 flex-wrap">
                          <div className="text-sm sm:text-base font-semibold text-white">{n.title}</div>
                          <div className="text-[11px] text-gray-500 shrink-0">
                            {new Date(n.createdAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="text-xs sm:text-sm text-gray-300 mt-1">{n.body}</div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-4 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  ← Previous
                </button>
                <span className="text-xs sm:text-sm text-gray-400">
                  Page {page} of {totalPages} · showing {items.length} of {totalCount}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-4 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
