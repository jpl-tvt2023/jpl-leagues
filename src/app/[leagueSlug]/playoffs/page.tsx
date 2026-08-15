"use client";

import { useLeague, useEnforceFormat } from "@/lib/league-context";
import { ClassicPlayoffs } from "../_components/playoffs/ClassicPlayoffs";
import { ContinentalChampionshipPlayoffs } from "../_components/playoffs/ContinentalChampionshipPlayoffs";

export default function LeaguePlayoffsPage() {
  useEnforceFormat(["tvt", "continental-championship"]);
  const { league } = useLeague();
  if (league.format === "continental-championship") return <ContinentalChampionshipPlayoffs />;
  return <ClassicPlayoffs />;
}
