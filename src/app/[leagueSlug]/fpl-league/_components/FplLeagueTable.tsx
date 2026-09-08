"use client";

import { fplEntryUrl } from "@/lib/fpl-links";
import { ChipPill, FplChipRow } from "@/components/ChipPill";
import type { FplLeagueTeam, TeamChipSlot } from "@/lib/fpl-league/team-stats";
import type { FplChipStatus } from "@/lib/fpl-league/chips";

export interface ManagerRowData {
  rank: number;
  teamId: string;
  teamName: string;
  playerName: string;
  fplId: string;
  gwPoints: number | null;
  gwTransferCost: number;
  totalPoints: number;
  /** Official FPL chips (WC/BB/TC/FH/AM) — NOT the league's own TVT chips. */
  chips: FplChipStatus;
  pending?: true;
}

/** Columns the header row spans. Browsers clamp this down when `Team` is hidden at <sm. */
const COLUMN_COUNT = 6;

/**
 * One manager's row.
 *
 * Extracted so the flat and team-grouped tables render byte-identical rows — the anchor, the
 * row click, the pending opacity and the transfer-cost suffix exist once.
 */
function ManagerRow({
  row,
  gw,
  grouped,
}: {
  row: ManagerRowData;
  gw: number | null;
  /** Inside a team block the team name is already on the header row directly above. */
  grouped: boolean;
}) {
  const href = fplEntryUrl(row.fplId, gw);
  return (
    <tr
      className={`border-b border-white/5 transition last:border-b-0 ${
        row.pending ? "opacity-60" : "hover:bg-white/5 cursor-pointer"
      }`}
      onClick={row.pending ? undefined : () => window.open(href, "_blank", "noopener,noreferrer")}
    >
      <td className="px-2 py-2 sm:px-3 text-gray-400 font-medium">{row.rank}</td>
      <td className="px-2 py-2 sm:px-3">
        {/* A real anchor as well as the row click, so keyboard and middle-click both work. */}
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="font-medium text-white hover:text-blue-300 transition"
        >
          {row.playerName}
        </a>
        {!grouped && (
          <div className="text-[10px] text-gray-500 sm:hidden truncate">{row.teamName}</div>
        )}
      </td>
      {!grouped && (
        <td className="px-2 py-2 sm:px-3 text-gray-300 hidden sm:table-cell truncate">
          {row.teamName}
        </td>
      )}
      <td className="px-1.5 py-2 sm:px-2 text-center text-white">
        {row.gwPoints == null ? (
          <span className="text-gray-600">—</span>
        ) : (
          <>
            {row.gwPoints}
            {row.gwTransferCost > 0 && (
              <span className="text-red-400 text-[10px]"> (−{row.gwTransferCost})</span>
            )}
          </>
        )}
      </td>
      <td className="px-1.5 py-2 sm:px-2 text-center font-bold text-white">
        {row.pending ? <span className="text-gray-600">—</span> : row.totalPoints}
      </td>
      <td className="px-2 py-2 sm:px-3">
        <div className="flex flex-wrap gap-1">
          {/* Coloured against the gameweek this table is showing, so a chip being played right
              now reads differently from one spent weeks ago. */}
          <FplChipRow status={row.chips} gwNumber={gw} />
        </div>
      </td>
    </tr>
  );
}

/** One set's worth of TVT chip pills, labelled so they cannot be read as FPL chips. */
function ChipSetCluster({
  set,
  slots,
  currentSet,
  headerGw,
}: {
  set: 1 | 2;
  slots: TeamChipSlot[];
  currentSet: 1 | 2 | "playoffs" | null;
  headerGw: number | null;
}) {
  const mine = slots.filter((s) => s.set === set);
  if (mine.length === 0) return null;
  return (
    <span className="flex items-center gap-1">
      <span
        className={`text-[9px] font-semibold uppercase tracking-wider ${
          currentSet === set ? "text-gray-300" : "text-gray-500"
        }`}
      >
        Set {set}
      </span>
      {mine.map((slot) => (
        <ChipPill
          key={`${slot.code}-${slot.set}`}
          code={slot.displayCode}
          label={`${slot.label}${slot.wasted ? " (wasted)" : ""}`}
          // Same mapping the PL Fixture card uses: only a chip played in the gameweek on
          // screen is "current"; anything else spent has receded into the past.
          state={slot.used ? (slot.gw === headerGw ? "current" : "past") : "available"}
          gw={slot.gw}
          // Tap-to-open: this page is read on phones, where a native title= is invisible.
          interactive
        />
      ))}
    </span>
  );
}

/**
 * A team's banner row: what it has spent, above the two managers who spent it.
 *
 * Deliberately not clickable — there is no FPL entry behind a team, and a header that visibly
 * does nothing on tap reads as broken.
 */
function TeamHeaderRow({
  team,
  currentSet,
  headerGw,
  compact,
}: {
  team: FplLeagueTeam;
  currentSet: 1 | 2 | "playoffs" | null;
  headerGw: number | null;
  /**
   * Keep the name and the stats on separate lines at every width.
   *
   * Set when two group tables share the row: `sm:` responds to the VIEWPORT, so a 600px-wide
   * table on a 1280px screen would otherwise take the side-by-side layout it has no room for.
   */
  compact: boolean;
}) {
  return (
    <tr className="border-t border-purple-500/10 bg-purple-900/20">
      <td colSpan={COLUMN_COUNT} className="px-2 py-2 sm:px-3">
        <div
          className={`flex flex-col gap-1 ${
            compact ? "" : "sm:flex-row sm:items-center sm:justify-between sm:gap-3"
          }`}
        >
          <span className="font-semibold text-white truncate">{team.teamName}</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {team.chips && (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-500">
                  TVT
                </span>
                <ChipSetCluster set={1} slots={team.chips} currentSet={currentSet} headerGw={headerGw} />
                <ChipSetCluster set={2} slots={team.chips} currentSet={currentSet} headerGw={headerGw} />
              </span>
            )}
            {team.captains.length > 0 && (
              <span className="text-[10px] text-gray-400">
                <span className="uppercase tracking-wider text-gray-500">Cap</span>{" "}
                {team.captains.map((c, i) => (
                  <span key={c.playerId}>
                    {i > 0 && <span className="text-gray-600"> · </span>}
                    {c.playerName} {c.used}/{c.cap}
                  </span>
                ))}
              </span>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

export function FplLeagueTable({
  rows,
  teams,
  gw,
  isLive,
  currentSet,
  groupLabel,
  compact = false,
}: {
  rows: ManagerRowData[];
  /** Empty means render the original flat table — auction, or team stats unavailable. */
  teams: FplLeagueTeam[];
  gw: number | null;
  isLive: boolean;
  currentSet: 1 | 2 | "playoffs" | null;
  groupLabel?: string;
  /** Narrow container (two tables side by side) — stack the header row content. */
  compact?: boolean;
}) {
  const grouped = teams.length > 0;
  const rowsByTeam = new Map<string, ManagerRowData[]>();
  for (const row of rows) {
    const list = rowsByTeam.get(row.teamId) ?? [];
    list.push(row);
    rowsByTeam.set(row.teamId, list);
  }
  // Should never fire, but it guarantees what is on screen always equals what the payload
  // carried, rather than silently dropping a manager whose team went missing.
  const orphans = grouped
    ? rows.filter((r) => !teams.some((t) => t.teamId === r.teamId))
    : [];

  return (
    <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur overflow-hidden">
      {groupLabel && (
        <div className="border-b border-purple-500/20 bg-purple-900/40 px-3 py-2 text-sm font-semibold text-white">
          Group {groupLabel}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-purple-500/20 bg-purple-900/30 text-[10px] sm:text-xs text-gray-300">
              <th className="px-2 py-2 sm:px-3 text-left font-medium w-10">#</th>
              <th className="px-2 py-2 sm:px-3 text-left font-medium">Player</th>
              {!grouped && (
                <th className="px-2 py-2 sm:px-3 text-left font-medium hidden sm:table-cell">Team</th>
              )}
              <th className="px-1.5 py-2 sm:px-2 text-center font-medium w-20">
                {gw ? `GW${gw}` : "GW"} Pts
                {isLive && (
                  <span className="ml-1 inline-flex items-center gap-1 text-green-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                    LIVE
                  </span>
                )}
              </th>
              <th className="px-1.5 py-2 sm:px-2 text-center font-medium w-16">Total</th>
              <th className="px-2 py-2 sm:px-3 text-left font-medium">FPL Chips</th>
            </tr>
          </thead>

          {grouped ? (
            <>
              {teams.map((team) => (
                <tbody key={team.teamId}>
                  <TeamHeaderRow team={team} currentSet={currentSet} headerGw={gw} compact={compact} />
                  {(rowsByTeam.get(team.teamId) ?? []).map((row) => (
                    <ManagerRow key={row.fplId} row={row} gw={gw} grouped />
                  ))}
                </tbody>
              ))}
              {orphans.length > 0 && (
                <tbody>
                  <tr className="border-t border-purple-500/10 bg-purple-900/20">
                    <td colSpan={COLUMN_COUNT} className="px-2 py-2 sm:px-3 font-semibold text-gray-400">
                      Unassigned
                    </td>
                  </tr>
                  {orphans.map((row) => (
                    <ManagerRow key={`${row.teamId}-${row.fplId}`} row={row} gw={gw} grouped />
                  ))}
                </tbody>
              )}
            </>
          ) : (
            <tbody>
              {rows.map((row) => (
                <ManagerRow key={`${row.teamId}-${row.fplId}`} row={row} gw={gw} grouped={false} />
              ))}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
