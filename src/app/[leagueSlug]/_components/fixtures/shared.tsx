"use client";

import { PlayerScoreFormula } from "../playoffs/shared";

export interface LivePlayerScore {
  name: string;
  fplId: string;
  fplScore: number;
  transferHits: number;
  isCaptain: boolean;
  isAutoAssigned?: boolean;
  isTempCaptain?: boolean;
  finalScore: number;
}

export interface LiveFixtureScore {
  fixtureId: string;
  gameweek: number;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  homePlayers: LivePlayerScore[];
  awayPlayers: LivePlayerScore[];
  /** Fixtures-left-to-play across home managers' starting XI. null when FPL fixtures unavailable. */
  playersLeftHome?: number | null;
  /** Fixtures-left-to-play across away managers' starting XI. null when FPL fixtures unavailable. */
  playersLeftAway?: number | null;
}

export interface FixtureTeam {
  id?: string;
  name: string;
  isGhost?: boolean;
}

export interface FixtureResult {
  homeScore: number;
  awayScore: number;
  homeMatchPoints?: number;
  awayMatchPoints?: number;
  homePlayerScores?: string | null;
  awayPlayerScores?: string | null;
}

export interface Fixture {
  id: string;
  homeTeam: FixtureTeam;
  awayTeam: FixtureTeam;
  group?: { name: string } | null;
  competitionType?: string | null;
  gameweek: { number: number; deadline?: Date };
  result?: FixtureResult | null;
}

export type GameweekFixtures = Record<number, Fixture[]>;

export function PlayerBreakdownSide({
  players,
  teamLabel,
  gwNumber,
  isGhost,
  ghostScore,
  playersLeft,
}: {
  players: LivePlayerScore[];
  teamLabel: string;
  gwNumber: number;
  isGhost?: boolean;
  ghostScore?: number;
  /** undefined = don't render the footer; null = FPL outage ("—"); number = count. */
  playersLeft?: number | null;
}) {
  return (
    <div>
      <div className="text-[10px] text-gray-400 mb-1 text-center">{teamLabel}</div>
      {isGhost ? (
        <div className="text-center py-3">
          <span className="text-purple-400 italic text-xs">Ghost (Group Avg)</span>
          {ghostScore !== undefined && (
            <div className="text-purple-300 font-bold mt-1">{ghostScore}</div>
          )}
        </div>
      ) : players.length > 0 ? (
        players.map((p, i) => (
          <div key={i} className="flex items-center justify-between py-1">
            <div className="flex items-center gap-1 min-w-0">
              <a
                href={`https://fantasy.premierleague.com/entry/${p.fplId}/event/${gwNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline truncate"
                onClick={(e) => e.stopPropagation()}
              >
                {p.name}
              </a>
              {p.isCaptain && p.isTempCaptain && (
                <span
                  className="px-1 py-0.5 rounded text-[9px] font-bold bg-amber-500/20 text-amber-400 shrink-0"
                  title="Auto-assigned: lowest current scorer. Locks at GW close unless admin overrides."
                >
                  C*
                </span>
              )}
              {p.isCaptain && !p.isTempCaptain && (
                <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-yellow-500/20 text-yellow-400 shrink-0">C</span>
              )}
            </div>
            <div className="text-right shrink-0 ml-2">
              <PlayerScoreFormula
                fplScore={p.fplScore}
                transferHits={p.transferHits}
                finalScore={p.finalScore}
                isCaptain={p.isCaptain}
                isTempCaptain={p.isTempCaptain}
              />
            </div>
          </div>
        ))
      ) : (
        <div className="text-center text-gray-500 italic text-[10px] py-2">No breakdown available</div>
      )}
      {!isGhost && playersLeft !== undefined && (
        <div className="mt-1 text-[10px] text-center">
          <span className={playersLeft != null && playersLeft > 0 ? "text-yellow-400" : "text-gray-500"}>
            {playersLeft == null ? "—" : playersLeft} players left to play
          </span>
        </div>
      )}
    </div>
  );
}

export function PlayerBreakdown({
  fixture,
  liveData,
}: {
  fixture: Fixture;
  liveData?: LiveFixtureScore;
}) {
  const homePlayers: LivePlayerScore[] =
    (liveData?.homePlayers?.length ?? 0) > 0
      ? liveData!.homePlayers
      : fixture.result?.homePlayerScores
      ? (JSON.parse(fixture.result.homePlayerScores) as LivePlayerScore[])
      : [];
  const awayPlayers: LivePlayerScore[] =
    (liveData?.awayPlayers?.length ?? 0) > 0
      ? liveData!.awayPlayers
      : fixture.result?.awayPlayerScores
      ? (JSON.parse(fixture.result.awayPlayerScores) as LivePlayerScore[])
      : [];
  const gwNumber = liveData?.gameweek ?? fixture.gameweek.number;

  if (homePlayers.length === 0 && awayPlayers.length === 0 && !fixture.homeTeam.isGhost && !fixture.awayTeam.isGhost) {
    return (
      <div className="mt-1 pt-2 border-t border-white/10 text-center text-gray-500 italic text-[10px] py-2">
        Player breakdown not available for this gameweek
      </div>
    );
  }

  const hasTempCaptain = [...homePlayers, ...awayPlayers].some(p => p.isTempCaptain);

  return (
    <div className="mt-1 pt-2 border-t border-white/10 text-xs">
      <div className="grid grid-cols-2 gap-2 sm:gap-4">
        <PlayerBreakdownSide
          players={homePlayers}
          teamLabel={fixture.homeTeam.name}
          gwNumber={gwNumber}
          isGhost={fixture.homeTeam.isGhost}
          ghostScore={fixture.result?.homeScore}
          playersLeft={liveData?.playersLeftHome}
        />
        <PlayerBreakdownSide
          players={awayPlayers}
          teamLabel={fixture.awayTeam.name}
          gwNumber={gwNumber}
          isGhost={fixture.awayTeam.isGhost}
          ghostScore={fixture.result?.awayScore}
          playersLeft={liveData?.playersLeftAway}
        />
      </div>
      {hasTempCaptain && (
        <div className="mt-2 text-[10px] text-amber-400/70">
          C* = auto-assigned temp captain (lowest scorer)
        </div>
      )}
    </div>
  );
}
