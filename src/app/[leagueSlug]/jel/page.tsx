import { redirect } from "next/navigation";

export default function JelRedirectPage({ params }: { params: { leagueSlug: string } }) {
  redirect(`/${params.leagueSlug}/jpl-cup-standings`);
}
