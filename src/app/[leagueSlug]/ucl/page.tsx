import { redirect } from "next/navigation";

export default function UCLPage({ params }: { params: { leagueSlug: string } }) {
  redirect(`/${params.leagueSlug}/uefa-standings`);
}
