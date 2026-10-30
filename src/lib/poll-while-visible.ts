/**
 * setInterval for client polls, minus the ticks nobody sees.
 *
 * A league page left open in a background tab kept polling all day — every tick a function
 * invocation and its Redis reads, for a reader who was not looking. This skips ticks while the
 * document is hidden, and when the tab comes back polls at once if a tick was missed, so a
 * returning reader never sits on numbers older than one interval. Same `document.hidden` guard
 * the dashboard's awaiting-results poll already uses.
 *
 * Returns the cleanup, so it drops into an effect in place of setInterval/clearInterval and keeps
 * that effect's restart behaviour exactly as it was.
 */
export function pollWhileVisible(tick: () => void, intervalMs: number): () => void {
  let last = Date.now(); // callers fetch once themselves right before starting the poll
  const onTick = () => {
    if (document.hidden) return;
    last = Date.now();
    tick();
  };
  let id = setInterval(onTick, intervalMs);

  const onVisibility = () => {
    if (document.hidden || Date.now() - last < intervalMs) return;
    // Catch up now and restart the cadence from here, so the old schedule's next tick cannot land
    // moments later and fetch the same numbers twice.
    clearInterval(id);
    onTick();
    id = setInterval(onTick, intervalMs);
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
