"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useEnforceFormat, useLeague } from "@/lib/league-context";
import type { MatchCenterPayload } from "@/lib/match-center/load";
import { PreDeadline } from "../../_components/match-center/PreDeadline";
import { Scoreboard, matchStatus, type CompareChoice } from "../../_components/match-center/Scoreboard";
import { TeamTable } from "../../_components/match-center/TeamTable";

/** Same cadence as the fixtures page, and for the same reason: inside the 10-minute live window. */
const LIVE_POLL_MS = 3 * 60 * 1000;

interface Query {
  gw: number | null;
  a: string | null;
  b: string | null;
}

function readQuery(): Query {
  const sp = new URLSearchParams(window.location.search);
  const gw = Number(sp.get("gw"));
  return { gw: Number.isInteger(gw) && gw > 0 ? gw : null, a: sp.get("a"), b: sp.get("b") };
}

/**
 * Match Center: two JPL teams' merged FPL squads, side by side, for one gameweek.
 *
 * Opens on the fixture that was clicked; the compare picker can then line up any two teams in
 * any started gameweek. The choice lives in the URL (?gw=&a=&b=) so a comparison can be shared.
 * Read via window.location rather than useSearchParams() — the same choice the squad page makes,
 * to avoid a Suspense boundary around an already fully client page.
 */
export default function MatchCenterPage() {
  const params = useParams();
  const leagueSlug = params.leagueSlug as string;
  const fixtureId = params.fixtureId as string;

  const { league, viewer } = useLeague();
  useEnforceFormat(["tvt", "continental-championship"]);
  const isContinental = league.format === "continental-championship";

  const [query, setQuery] = useState<Query | null>(null);
  const [data, setData] = useState<MatchCenterPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Below lg the two squads cannot sit side by side; the reader picks one with a tab.
  const [mobileSide, setMobileSide] = useState<"a" | "b">("a");
  // Only the newest request may land: switching teams while a slow load is in flight must not
  // let the older comparison overwrite the newer one.
  const requestSeq = useRef(0);

  useEffect(() => {
    setQuery(readQuery());
  }, []);

  const load = useCallback(
    async (q: Query, background = false) => {
      const seq = ++requestSeq.current;
      if (background) setIsRefreshing(true);
      else setIsLoading(true);
      try {
        const sp = new URLSearchParams({ leagueSlug, fixtureId });
        if (q.gw) sp.set("gw", String(q.gw));
        if (q.a) sp.set("a", q.a);
        if (q.b) sp.set("b", q.b);
        const res = await fetch(`/api/match-center?${sp.toString()}`);
        const body = await res.json().catch(() => null);
        if (seq !== requestSeq.current) return;
        if (!res.ok) {
          setError(body?.error ?? "Could not load the Match Center.");
          return;
        }
        setData(body as MatchCenterPayload);
        setError(null);
      } catch {
        if (seq === requestSeq.current) setError("Could not reach the server — check your connection.");
      } finally {
        if (seq === requestSeq.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [leagueSlug, fixtureId],
  );

  useEffect(() => {
    if (query) void load(query);
  }, [query, load]);

  const status = data ? matchStatus(data) : null;

  useEffect(() => {
    if (status !== "live" || !query) return;
    const t = setInterval(() => void load(query, true), LIVE_POLL_MS);
    return () => clearInterval(t);
  }, [status, query, load]);

  // Drives the deadline countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const onCompareChange = (next: CompareChoice) => {
    setQuery({ gw: next.gw, a: next.a, b: next.b });
    const sp = new URLSearchParams({ gw: String(next.gw), a: next.a, b: next.b });
    window.history.replaceState(null, "", `${window.location.pathname}?${sp.toString()}`);
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  return (
    <div
      className={`min-h-screen bg-gradient-to-b ${
        isContinental ? "from-[#37003c] via-[#1a0021] to-[#0d001a]" : "from-slate-900 via-purple-900 to-slate-900"
      }`}
    >
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="fixtures"
        format={isContinental ? "continental-championship" : "tvt"}
        teamSize={league.teamSize}
        isLoggedIn={viewer.authenticated}
        dashboardHref={viewer.dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6 py-4 sm:py-8 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/${leagueSlug}/fixtures`} className="text-xs text-gray-400 hover:text-white transition">
            ← Fixtures
          </Link>
          <h1 className="text-lg sm:text-2xl font-bold text-white">Match Center</h1>
          <span className="w-16" aria-hidden />
        </div>

        {isLoading && !data ? (
          <LoadingScreen variant="fixtures" fullScreen={false} label="Loading Match Center" />
        ) : error && !data ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center text-sm text-red-300">{error}</div>
        ) : data && status ? (
          <div className={`space-y-4 transition-opacity ${isLoading ? "opacity-60" : ""}`} aria-busy={isLoading}>
            {error && (
              <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-300">{error}</div>
            )}
            <Scoreboard
              data={data}
              status={status}
              onChange={onCompareChange}
              disabled={isLoading}
              isRefreshing={isRefreshing}
              now={now}
              accent={isContinental ? "continental" : "default"}
            />

            {status === "upcoming" ? (
              <PreDeadline sides={[data.a, data.b]} gwNumber={data.gameweek.number} />
            ) : data.degraded ? (
              <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4 text-center text-sm text-amber-200">
                FPL is busy right now (a scoring run or a rate limit), so line-ups can&apos;t be loaded.
                The scores above are still current — try again in a minute.
              </div>
            ) : (
              <>
                {/* Phones: one squad at a time. Sticky just under the app bar, and carrying both
                    scores, so the score stays in view while scrolling a squad. */}
                <div
                  role="tablist"
                  aria-label="Choose team"
                  className="lg:hidden sticky top-[calc(4rem+env(safe-area-inset-top))] z-30 grid grid-cols-2 gap-1 rounded-xl border border-white/10 bg-slate-900/90 p-1 backdrop-blur"
                >
                  {(["a", "b"] as const).map((k) => {
                    const side = data[k];
                    return (
                      <button
                        key={k}
                        role="tab"
                        aria-selected={mobileSide === k}
                        onClick={() => setMobileSide(k)}
                        className={`flex min-w-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                          mobileSide === k ? "bg-white/15 text-white" : "text-gray-400 hover:text-white"
                        }`}
                      >
                        <span className="truncate">{side.teamName}</span>
                        <span className="shrink-0">{side.displayTotal ?? "–"}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                  <TeamTable
                    side={data.a}
                    perspective="a"
                    comparison={data.comparison}
                    settled={data.gameweek.settled}
                    accentClass="border-sky-400/25"
                    className={mobileSide === "b" ? "hidden lg:block" : ""}
                  />
                  <TeamTable
                    side={data.b}
                    perspective="b"
                    comparison={data.comparison}
                    settled={data.gameweek.settled}
                    accentClass="border-rose-400/25"
                    className={mobileSide === "a" ? "hidden lg:block" : ""}
                  />
                </div>

                <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px] text-gray-500">
                  <span><span className="inline-block h-2.5 w-1 rounded-sm bg-violet-400 align-middle" /> DIFF — only this team owns him</span>
                  <span><span className="inline-block h-2.5 w-1 rounded-sm bg-emerald-400 align-middle" /> +N× — counted more times than by the other team</span>
                  <span>═ dimmed — shared at the same ×, cancels out</span>
                  <span>★ JPL captain (counts double)</span>
                  <span>Tap a name for the points breakdown</span>
                </p>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
