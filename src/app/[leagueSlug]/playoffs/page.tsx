"use client";

import { useLeague, useEnforceFormat } from "@/lib/league-context";
import { ClassicPlayoffs } from "../_components/playoffs/ClassicPlayoffs";
import { TripleCrownPlayoffs } from "../_components/playoffs/TripleCrownPlayoffs";

export default function LeaguePlayoffsPage() {
  useEnforceFormat(["tvt", "triple-crown"]);
  const { league } = useLeague();
  if (league.format === "triple-crown") return <TripleCrownPlayoffs />;
  return <ClassicPlayoffs />;
}
