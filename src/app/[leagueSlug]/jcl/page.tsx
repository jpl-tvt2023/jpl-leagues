import { redirect } from "next/navigation";

// `params` is a Promise in Next 15+; typing it as a plain object fails the
// production type check (the dev server tolerates it, so this went unnoticed).
export default async function JclRedirectPage({ params }: { params: Promise<{ leagueSlug: string }> }) {
  const { leagueSlug } = await params;
  redirect(`/${leagueSlug}/jpl-cup-standings`);
}
