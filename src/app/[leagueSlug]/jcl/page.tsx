import { redirect } from "next/navigation";

export default function JclRedirectPage({ params }: { params: { leagueSlug: string } }) {
  redirect(`/${params.leagueSlug}/jpl-cup-standings`);
}
