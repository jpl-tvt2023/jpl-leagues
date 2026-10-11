import { redirect } from "next/navigation";

/**
 * The Match Center used to live here, under its fixture. It is a page of its own now
 * (/{league}/match-center); this keeps links already shared in group chats working.
 */
export default async function LegacyMatchCenterRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ leagueSlug: string; fixtureId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { leagueSlug, fixtureId } = await params;
  const qs = new URLSearchParams({ fixture: fixtureId });
  for (const [key, value] of Object.entries(await searchParams)) {
    if (key !== "fixture" && typeof value === "string") qs.set(key, value);
  }
  redirect(`/${leagueSlug}/match-center?${qs.toString()}`);
}
