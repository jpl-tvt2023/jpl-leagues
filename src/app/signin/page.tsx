"use client";

import { useState } from "react";
import Link from "next/link";

export default function SignInPage() {
  const [formData, setFormData] = useState({
    identifier: "",
    password: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    try {
      const response = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Sign in failed" });
        return;
      }

      setMessage({ type: "success", text: "Signed in successfully!" });
      
      // Redirect based on role and status
      if (data.user) {
        // Admin login — respect mustChangePassword redirect
        window.location.href = data.redirectTo || "/admin";
      } else if (data.team) {
        // Team login
        if (data.team.mustChangePassword) {
          window.location.href = "/change-password";
        } else {
          window.location.href = "/dashboard";
        }
      }
    } catch {
      setMessage({ type: "error", text: "Network error. Please try again." });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-purple-900 to-slate-900">
      {/* Navigation */}
      <nav className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4 lg:px-12 border-b border-white/10">
        <Link href="/" className="flex items-center gap-2">
          <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-yellow-400 to-orange-500 flex items-center justify-center font-bold text-slate-900 shrink-0">
            TVT
          </div>
          <span className="text-xl font-bold text-white hidden sm:inline">Fantasy Super League</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/standings" className="text-gray-300 hover:text-white transition">
            Standings
          </Link>
          <Link href="/fixtures" className="text-gray-300 hover:text-white transition">
            Fixtures
          </Link>
          <Link href="/playoffs" className="text-gray-300 hover:text-white transition">
            Playoffs
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-md px-6 py-24">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-white mb-4">Welcome Back</h1>
          <p className="text-gray-400">
            Sign in with your team ID or admin email.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur">
            {message && (
              <div
                className={`mb-6 rounded-lg p-4 ${
                  message.type === "success"
                    ? "bg-green-500/10 border border-green-500/30 text-green-400"
                    : "bg-red-500/10 border border-red-500/30 text-red-400"
                }`}
              >
                {message.text}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Team ID or Admin Email
                </label>
                <input
                  type="text"
                  required
                  value={formData.identifier}
                  onChange={(e) => setFormData({ ...formData, identifier: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
                  suppressHydrationWarning
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Password
                </label>
                <input
                  type="password"
                  required
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder="••••••••"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-6 w-full rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Signing in..." : "Sign In"}
            </button>
          </div>
        </form>

        <p className="mt-8 text-center text-sm text-gray-500">
          Don't have credentials? Contact your league admin.
        </p>
      </div>
    </div>
  );
}
