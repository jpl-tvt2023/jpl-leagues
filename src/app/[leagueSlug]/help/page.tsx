"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { useLeague, useEnforceFormat } from "@/lib/league-context";
import { TripleCrownHelp } from "../_components/help/TripleCrownHelp";
import { TvtHelp } from "../_components/help/TvtHelp";
import type { UserRole } from "../_components/help/shared";

export default function LeagueHelpPage() {
  useEnforceFormat(["tvt", "triple-crown"]);

  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;

  const { league, viewer } = useLeague();

  useEffect(() => {
    if (!viewer.authenticated) router.push("/signin");
  }, [viewer.authenticated, router]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const userRole: UserRole =
    viewer.type === "admin" || viewer.type === "superadmin"
      ? "admin"
      : viewer.type === "team"
      ? "team"
      : "public";

  const isTripleCrown = league.format === "triple-crown";
  const variantLabel = isTripleCrown
    ? "Triple Crown"
    : league.teamSize === 8
    ? "8-Team"
    : league.teamSize === 16
    ? "16-Team"
    : "32-Team";

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="help"
        format={isTripleCrown ? "triple-crown" : "tvt"}
        isLoggedIn={viewer.authenticated}
        dashboardHref={viewer.dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 rounded-full bg-yellow-400/10 border border-yellow-400/20 px-4 py-1.5 text-sm text-yellow-400 font-medium mb-4">
            {variantLabel} Format
          </div>
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-3">Help &amp; Guidance</h1>
          <p className="text-gray-400">
            {league.name ? `${league.name} · ` : ""}FAQs and step-by-step scenarios for this league
          </p>
          {userRole !== "public" && (
            <p className="text-xs text-purple-400 mt-2">
              {userRole === "team" ? "Showing team member content" : "Showing admin + team content"}
            </p>
          )}
        </div>

        {isTripleCrown ? (
          <TripleCrownHelp userRole={userRole} />
        ) : (
          <TvtHelp
            userRole={userRole}
            teamSize={league.teamSize}
            enabledChips={league.enabledChips.length ? league.enabledChips : ["D", "W", "C"]}
            leagueStageEnd={league.playoffStartGw - 1}
          />
        )}

        <div className="mt-10 text-center text-sm text-gray-500">
          Still have questions? Contact your league admin or visit the{" "}
          <Link href={`/${leagueSlug}/rules`} className="text-yellow-400 hover:text-yellow-300 transition">
            Rules page
          </Link>{" "}
          for full technical details.
        </div>
      </div>
    </div>
  );
}
