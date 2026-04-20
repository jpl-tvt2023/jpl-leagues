"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoadingScreen } from "@/components/LoadingScreen";

export default function RulesRedirect() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      const slugFromUrl = new URLSearchParams(window.location.search).get("adminLeague");
      if (slugFromUrl) {
        router.replace(`/${slugFromUrl}/rules`);
        return;
      }

      try {
        const res = await fetch("/api/auth/me");
        const d = await res.json();
        if (!res.ok || !d.authenticated) {
          router.replace("/signin");
          return;
        }
        if (d.leagueSlug) {
          router.replace(`/${d.leagueSlug}/rules`);
          return;
        }
        router.replace(d.type === "admin" || d.type === "superadmin" ? "/admin" : "/dashboard");
      } catch {
        router.replace("/signin");
      }
    })();
  }, [router]);

  return <LoadingScreen variant="rules" />;
}
