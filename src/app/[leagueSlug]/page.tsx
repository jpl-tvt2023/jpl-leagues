import { redirect } from "next/navigation";

interface LeagueHomePageProps {
  params: Promise<{ leagueSlug: string }>;
}

// Bare-slug URL (e.g. /jpl-tvt-32) redirects to /standings so the page no
// longer 404s. The layout already resolves the league row and the standings
// page is the natural landing experience for both authenticated and anonymous
// visitors.
export default async function LeagueHomePage({ params }: LeagueHomePageProps) {
  const { leagueSlug } = await params;
  redirect(`/${leagueSlug}/standings`);
}
