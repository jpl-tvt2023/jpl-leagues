"use client";

/**
 * FPL Classic — the rules, as published to a public audience.
 *
 * Two things here are load-bearing beyond being nice copy:
 *
 *  1. The month rule. A gameweek belongs to the calendar month of its DEADLINE, in UTC. That is
 *     a real decision with visible consequences (a late-November deadline whose matches are
 *     played in December counts as November), and it is frozen onto each settled row so it can
 *     never move afterward. If it isn't written down, the first disputed monthly winner has
 *     nothing to point at.
 *  2. No prize amounts. This page announces winners; it never lists prizes. The award data model
 *     has no field for one — see the comment at the top of lib/fpl-classic/awards.ts.
 */

export function FplClassicRules({
  scoringMetric,
  winnerCutPercent,
  startGameweek,
  fplLeagueId,
}: {
  scoringMetric: "net" | "gross";
  winnerCutPercent: number;
  startGameweek: number;
  fplLeagueId: number | null;
}) {
  return (
    <div className="space-y-6 text-sm sm:text-base text-gray-300">
      <Section title="What this league is">
        <p>
          A straight mirror of an official FPL classic mini-league
          {fplLeagueId != null && <> (league <span className="font-mono text-sky-300">#{fplLeagueId}</span>)</>}.
          Every score here comes from your own FPL team — there are no separate squads, no
          captain announcements, and nothing to submit on this site. This page is public and
          read-only; there is no account to create and nothing to sign in to.
        </p>
      </Section>

      <Section title="How scoring works">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            Your gameweek score is{" "}
            {scoringMetric === "net" ? (
              <>your FPL points <strong className="text-white">after</strong> any transfer-hit deductions</>
            ) : (
              <>your FPL points <strong className="text-white">before</strong> transfer-hit deductions</>
            )}
            .
          </li>
          <li>The season table is your cumulative total, exactly as FPL reports it.</li>
          {startGameweek > 1 && (
            <li>This league counts from <strong className="text-white">GW{startGameweek}</strong> onward.</li>
          )}
          <li>Ties share a rank. Two managers level on points are both placed equal, and the next rank skips accordingly.</li>
        </ul>
      </Section>

      <Section title="Gameweek and monthly leaderboards">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>Each shows the <strong className="text-white">top 10</strong>. Where a tie straddles 10th place, everyone tied is shown — so the list can run past ten names.</li>
          <li>
            A gameweek belongs to the calendar month of its <strong className="text-white">FPL deadline</strong>, in UTC.
            A gameweek whose deadline falls in late November counts as November even if most of its
            matches are played in December.
          </li>
          <li>
            A monthly leaderboard only counts managers who were in the league for the{" "}
            <strong className="text-white">whole</strong> month. Joining midway through means you
            start from the following month.
          </li>
          <li>
            Likewise, a gameweek leaderboard only includes managers who had joined by that
            gameweek — though your full FPL history still counts toward the season table.
          </li>
        </ul>
      </Section>

      <Section title="Winners">
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            <strong className="text-white">Season</strong> — the top{" "}
            <strong className="text-white">{winnerCutPercent}%</strong> of entrants by season
            total. The cutoff line is marked in the standings table as the season goes on.
          </li>
          <li><strong className="text-white">Gameweek winners</strong> — the highest score in each gameweek.</li>
          <li><strong className="text-white">Monthly winners</strong> — the highest total across each complete month.</li>
          <li><strong className="text-white">Highest gameweek score</strong> — the single biggest haul of the season.</li>
          <li><strong className="text-white">Best bench points</strong> — the most points left on the bench across the season.</li>
        </ul>
        <p className="mt-3 text-gray-400">
          A winner marked <span className="text-sky-200 font-semibold">Final</span> has been
          confirmed and will not change. One marked{" "}
          <span className="text-amber-400 font-semibold">Provisional</span> is computed from
          settled data but not yet confirmed. One marked{" "}
          <span className="text-amber-400 font-semibold">Leading</span> is not a winner at all —
          that period is still being played, and it simply shows who is ahead so far.
        </p>
        <p className="mt-3 text-gray-400">
          All of them are listed on the <strong className="text-white">Winners</strong> page.
        </p>
        <p className="mt-3 text-gray-400">
          Prizes are announced separately and are never listed on this site.
        </p>
      </Section>

      <Section title="When the numbers update">
        <p>
          Standings refresh from FPL while a gameweek is in play, so the live column moves as
          matches finish. Gameweek and monthly leaderboards fill in once FPL has finalised a
          gameweek — all matches played and bonus points confirmed — and an admin has processed it.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 backdrop-blur">
      <h2 className="text-lg sm:text-xl font-bold text-white mb-3">{title}</h2>
      {children}
    </section>
  );
}
