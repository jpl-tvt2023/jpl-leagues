"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { LeagueNav } from "@/components/LeagueNav";
import { useLeague } from "@/lib/league-context";

const MAX_SUBJECT = 200;
const MIN_MESSAGE = 5;
const MAX_MESSAGE = 5000;

export default function FeedbackPage() {
  const params = useParams();
  const router = useRouter();
  const leagueSlug = params.leagueSlug as string;
  const { league, viewer } = useLeague();

  const [scope, setScope] = useState<"site" | "league">("league");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<{ kind: "idle" | "success" | "error"; text: string }>({
    kind: "idle",
    text: "",
  });

  useEffect(() => {
    if (!viewer.authenticated) router.push("/signin");
  }, [viewer.authenticated, router]);

  const handleSignOut = async () => {
    await fetch("/api/auth/signout", { method: "POST" });
    window.location.href = "/signin";
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const trimmed = message.trim();
    if (trimmed.length < MIN_MESSAGE) {
      setStatus({ kind: "error", text: `Message must be at least ${MIN_MESSAGE} characters.` });
      return;
    }
    if (trimmed.length > MAX_MESSAGE) {
      setStatus({ kind: "error", text: `Message must be ${MAX_MESSAGE} characters or fewer.` });
      return;
    }
    if (subject.trim().length > MAX_SUBJECT) {
      setStatus({ kind: "error", text: `Subject must be ${MAX_SUBJECT} characters or fewer.` });
      return;
    }

    setSubmitting(true);
    setStatus({ kind: "idle", text: "" });
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ scope, subject: subject.trim() || undefined, message: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus({ kind: "error", text: body.error || "Failed to submit feedback." });
        return;
      }
      setStatus({ kind: "success", text: "Thank you — your feedback has been recorded." });
      setSubject("");
      setMessage("");
    } catch {
      setStatus({ kind: "error", text: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  };

  const isContinentalChampionship = league.format === "continental-championship";
  const isAuction = league.format === "auction";
  const navFormat: "auction" | "continental-championship" | "tvt" = isAuction
    ? "auction"
    : isContinentalChampionship
    ? "continental-championship"
    : "tvt";

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      <LeagueNav
        leagueSlug={leagueSlug}
        leagueName={league.name}
        currentPage="feedback"
        format={navFormat}
        teamSize={league.teamSize}
        auctionTier={league.auctionTier ?? "complete"}
        isLoggedIn={viewer.authenticated}
        dashboardHref={viewer.dashboardHref}
        onSignOut={handleSignOut}
      />

      <div className="mx-auto max-w-2xl px-4 sm:px-6 py-8 sm:py-12">
        <div className="text-center mb-8">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2">Send Feedback</h1>
          <p className="text-gray-400 text-sm">
            Share thoughts about the platform or this league. Admins of {league.name} can see league feedback;
            site feedback goes to superadmins.
          </p>
        </div>

        <form onSubmit={onSubmit} className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur space-y-5">
          <div>
            <label htmlFor="feedback-scope" className="block text-sm font-medium text-gray-200 mb-1">
              Scope
            </label>
            <select
              id="feedback-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as "site" | "league")}
              className="w-full rounded-md bg-slate-800 border border-white/10 text-gray-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
            >
              <option value="league">{league.name}</option>
              <option value="site">Site (general)</option>
            </select>
          </div>

          <div>
            <label htmlFor="feedback-subject" className="block text-sm font-medium text-gray-200 mb-1">
              Subject <span className="text-gray-500 font-normal">(optional)</span>
            </label>
            <input
              id="feedback-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={MAX_SUBJECT}
              placeholder="Short summary"
              className="w-full rounded-md bg-slate-800 border border-white/10 text-gray-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
            />
            <div className="text-xs text-gray-500 mt-1">{subject.length}/{MAX_SUBJECT}</div>
          </div>

          <div>
            <label htmlFor="feedback-message" className="block text-sm font-medium text-gray-200 mb-1">
              Message
            </label>
            <textarea
              id="feedback-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={MAX_MESSAGE}
              rows={8}
              required
              placeholder="What's on your mind?"
              className="w-full rounded-md bg-slate-800 border border-white/10 text-gray-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
            />
            <div className="text-xs text-gray-500 mt-1">{message.length}/{MAX_MESSAGE} (minimum {MIN_MESSAGE})</div>
          </div>

          {status.kind !== "idle" && (
            <div
              role="status"
              className={`rounded-md px-3 py-2 text-sm ${
                status.kind === "success"
                  ? "bg-green-500/10 border border-green-500/30 text-green-300"
                  : "bg-red-500/10 border border-red-500/30 text-red-300"
              }`}
            >
              {status.text}
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            <button
              type="submit"
              disabled={submitting || message.trim().length < MIN_MESSAGE}
              className="rounded-md bg-yellow-400 text-slate-900 font-semibold px-4 py-2 hover:bg-yellow-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Sending…" : "Send feedback"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
