/**
 * How current the live numbers next to this are.
 *
 * Anywhere that serves stale scores first and refreshes behind them needs to say
 * so, or the reader has no way to tell a frozen score from a settled one. Two
 * states, deliberately small and unobtrusive:
 *
 *   - fetching  → a spinning icon, because something is happening
 *   - settled   → the time those numbers were taken
 *
 * Shared rather than written per page: the fixtures page and the dashboard card
 * both do this, and an indicator that means one thing in one place and something
 * else in another is worse than none.
 */
export function LiveFreshness({
  updatedAt,
  isRefreshing,
  className = "",
}: {
  /** ISO timestamp the numbers were computed. Null before anything has loaded. */
  updatedAt: string | null;
  /** A refresh is in flight behind whatever is currently on screen. */
  isRefreshing: boolean;
  className?: string;
}) {
  if (isRefreshing) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-[10px] sm:text-xs text-gray-400 ${className}`}
        title="Fetching the latest scores from FPL"
      >
        <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
        Updating…
      </span>
    );
  }

  if (!updatedAt) return null;

  const when = new Date(updatedAt);
  if (Number.isNaN(when.getTime())) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] sm:text-xs text-gray-500 ${className}`}
      title={`Scores as of ${when.toLocaleString()}`}
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" strokeWidth={2} />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 7v5l3 2" />
      </svg>
      Updated {when.toLocaleTimeString()}
    </span>
  );
}
