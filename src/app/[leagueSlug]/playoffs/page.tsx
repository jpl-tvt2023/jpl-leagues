"use client";

import { useLeague, useEnforceFormat } from "@/lib/league-context";
import { ClassicPlayoffs } from "../_components/playoffs/ClassicPlayoffs";
import { TripleCrownPlayoffs } from "../_components/playoffs/TripleCrownPlayoffs";

export default function LeaguePlayoffsPage() {
  useEnforceFormat(["tvt", "continental-championship"]);
  const { league } = useLeague();
  if (league.format === "continental-championship") return <TripleCrownPlayoffs />;
  return <ClassicPlayoffs />;
}
