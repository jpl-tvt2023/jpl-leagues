import { redirect } from "next/navigation";

export default function EuropaPage({ params }: { params: { leagueSlug: string } }) {
  redirect(`/${params.leagueSlug}/uefa-standings`);
}
