"use client";

import { useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";

export default function ChangePasswordPage() {
  const [formData, setFormData] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const passwordChecks = {
    length: formData.newPassword.length >= 8,
    numberOrSpecial: /[\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(formData.newPassword),
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    if (formData.newPassword !== formData.confirmPassword) {
      setMessage({ type: "error", text: "New passwords do not match" });
      setIsSubmitting(false);
      return;
    }

    if (formData.newPassword.length < 8) {
      setMessage({ type: "error", text: "New password must be at least 8 characters" });
      setIsSubmitting(false);
      return;
    }

    if (!/[\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(formData.newPassword)) {
      setMessage({ type: "error", text: "New password must contain at least one number or special character" });
      setIsSubmitting(false);
      return;
    }

    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: formData.currentPassword,
          newPassword: formData.newPassword,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setMessage({ type: "error", text: data.error || "Failed to change password" });
        return;
      }

      setMessage({ type: "success", text: "Password changed successfully! Redirecting..." });
      setTimeout(() => {
        window.location.href = data.redirectTo || "/";
      }, 2000);
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
          <span className="text-xl font-bold text-white hidden sm:inline">Fantasy Super League</span>
        </Link>
      </nav>

      <div className="mx-auto max-w-md px-4 sm:px-6 py-10 sm:py-24">
        <div className="text-center mb-8 sm:mb-12">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2 sm:mb-4">Change Password</h1>
          <p className="text-sm sm:text-base text-gray-400">
            Please set a new password for your account.
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
                  Current Password
                </label>
                <input
                  type="password"
                  required
                  value={formData.currentPassword}
                  onChange={(e) => setFormData({ ...formData, currentPassword: e.target.value })}
                  placeholder="Enter your current password"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Use the password provided by your admin for first-time login.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  New Password
                </label>
                <input
                  type="password"
                  required
                  value={formData.newPassword}
                  onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
                  placeholder="Enter your new password"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
                />
                <ul className="mt-2 space-y-1">
                  <li className={`text-xs flex items-center gap-1.5 ${passwordChecks.length ? "text-green-400" : "text-gray-500"}`}>
                    <span>{passwordChecks.length ? "✓" : "○"}</span>
                    At least 8 characters
                  </li>
                  <li className={`text-xs flex items-center gap-1.5 ${passwordChecks.numberOrSpecial ? "text-green-400" : "text-gray-500"}`}>
                    <span>{passwordChecks.numberOrSpecial ? "✓" : "○"}</span>
                    Contains a number or special character
                  </li>
                </ul>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  required
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                  placeholder="Confirm your new password"
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-6 w-full rounded-lg bg-gradient-to-r from-yellow-400 to-orange-500 px-6 py-3 font-semibold text-slate-900 hover:from-yellow-300 hover:to-orange-400 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "Changing Password..." : "Change Password"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
