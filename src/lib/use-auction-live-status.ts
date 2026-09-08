"use client";

import { useEffect, useState } from "react";

/**
 * Polls whether an auction is currently live for a league.
 *
 * Lifted out of `LeagueNav` so the nav shell owns exactly one interval per page no
 * matter which surface renders it. The nav uses this to hide the Marketplace link
 * during a live auction (the mid-auction trade freeze).
 *
 * `enabled` short-circuits the whole effect, so non-auction surfaces issue no request.
 */
export function useAuctionLiveStatus(leagueSlug: string, enabled: boolean): boolean {
  const [auctionLive, setAuctionLive] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`/api/auction/live-status?leagueSlug=${encodeURIComponent(leagueSlug)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setAuctionLive(!!data.live);
      } catch {
        // ignore
      }
    };
    check();
    const t = setInterval(check, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [enabled, leagueSlug]);

  return auctionLive;
}
