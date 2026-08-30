"use client";

import { useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";

/**
 * Eye / eye-off, inlined rather than pulled from an icon package — this repo
 * has no icon dependency and every other glyph is a hand-written <svg>.
 * `off` means the password is currently visible, so the icon offers to hide it.
 */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      className="w-5 h-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {off ? (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 3l18 18M10.6 10.6a3 3 0 004.2 4.2M9.9 5.1A9.6 9.6 0 0112 4.9c4.6 0 8.3 3 9.7 7.1a11.7 11.7 0 01-3.4 4.8M6.2 6.7A11.7 11.7 0 002.3 12c1.4 4.1 5.1 7.1 9.7 7.1 1.4 0 2.7-.3 3.9-.8"
        />
      ) : (
        <>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2.3 12C3.7 7.9 7.4 4.9 12 4.9s8.3 3 9.7 7.1c-1.4 4.1-5.1 7.1-9.7 7.1s-8.3-3-9.7-7.1z"
          />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export default function SignInPage() {
  const [formData, setFormData] = useState({
    identifier: "",
    password: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Off by default. Revealing is a deliberate act, and it keeps the field a
  // real password input for browsers, password managers and the E2E helper.
  const [showPassword, setShowPassword] = useState(false);
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

      // Trust the server's `redirectTo` for both admin and team flows. The server is the single
      // source of truth (it knows mustChangePassword, isProfileComplete, role). Falling back to
      // local conditionals would only re-introduce divergence between paths.
      if (data.redirectTo) {
        window.location.href = data.redirectTo;
      } else {
        window.location.href = data.user ? "/admin" : "/dashboard";
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
          <Logo />
          <span className="text-xl font-bold text-white hidden sm:inline">JPL Sports</span>
        </Link>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-sm sm:text-base">
          <Link href="/" className="text-gray-300 hover:text-white transition">
            All Leagues
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-md px-4 sm:px-6 py-10 sm:py-24">
        <div className="text-center mb-8 sm:mb-12">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2 sm:mb-4">Welcome Back</h1>
          <p className="text-sm sm:text-base text-gray-400">
            Sign in with your team ID or admin email.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-8 backdrop-blur">
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
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    required
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="••••••••"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 pr-12 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    aria-pressed={showPassword}
                    title={showPassword ? "Hide password" : "Show password"}
                    // Not focusable by tab: it sits between the password field
                    // and Sign In, and nobody tabbing through a login form
                    // wants a stop there. Still reachable by pointer and by
                    // screen readers.
                    tabIndex={-1}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-white transition"
                  >
                    <EyeIcon off={showPassword} />
                  </button>
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-6 w-full rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 text-sm sm:text-base font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Signing in..." : "Sign In"}
            </button>
          </div>
        </form>

        <p className="mt-8 text-center text-sm text-gray-500">
          Don&apos;t have credentials? Contact your league admin.
        </p>
      </div>
    </div>
  );
}
