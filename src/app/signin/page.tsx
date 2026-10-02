"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import { AppNav } from "@/components/AppNav";
import { AccountAvatar } from "@/components/AccountSwitcher";
import { NavIcon } from "@/components/icons/NavIcon";
import {
  announceAuthChange,
  forgetLogin,
  rememberLogin,
  switchAccount,
  useDeviceAccounts,
  useRememberedLogins,
} from "@/lib/accounts-client";

const noopSubscribe = () => () => {};
/** `/signin?add=1` — reached from "Add another account"; the current accounts stay signed in. */
const readIsAdding = () => new URLSearchParams(window.location.search).has("add");

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
  const passwordRef = useRef<HTMLInputElement>(null);

  const isAdding = useSyncExternalStore(noopSubscribe, readIsAdding, () => false);
  // Accounts still signed in on this device — one tap to continue as any of them.
  const { accounts } = useDeviceAccounts();
  const [switchingKey, setSwitchingKey] = useState<string | null>(null);
  // Login IDs used here before (never passwords) whose session has since ended.
  const remembered = useRememberedLogins();
  const signedInIds = new Set((accounts ?? []).map((a) => a.loginId?.toLowerCase()).filter(Boolean));
  const recent = remembered.filter((r) => !signedInIds.has(r.loginId.toLowerCase()));

  const onContinue = async (key: string) => {
    setSwitchingKey(key);
    setMessage(null);
    const result = await switchAccount(key);
    if (result?.error) {
      setMessage({ type: "error", text: result.error });
      setSwitchingKey(null);
    }
  };

  const fillRemembered = (loginId: string) => {
    setFormData((f) => ({ ...f, identifier: loginId }));
    passwordRef.current?.focus();
  };

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

      // Offer this login ID next time (never the password — that is the password manager's job),
      // and tell other open tabs that the active account just changed under them.
      const label: string = data.team?.name ?? data.user?.name ?? formData.identifier;
      rememberLogin({ loginId: formData.identifier.trim(), label });
      announceAuthChange({ type: "account-switched", label });

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
      <AppNav context={{ surface: "public", page: "signin" }} activeKey="" brandHref="/" brandLabel="JPL Sports" title="Sign in" />

      <div className="mx-auto max-w-md px-4 sm:px-6 py-10 sm:py-24">
        <div className="text-center mb-8 sm:mb-12">
          <h1 className="text-2xl sm:text-4xl font-bold text-white mb-2 sm:mb-4">
            {isAdding ? "Add another account" : "Welcome Back"}
          </h1>
          <p className="text-sm sm:text-base text-gray-400">
            {isAdding
              ? "Your other accounts stay signed in on this device — switch between them from the menu."
              : "Sign in with your team ID or admin email."}
          </p>
        </div>

        {accounts && accounts.length > 0 && (
          <section aria-labelledby="signed-in-accounts" className="mb-6 rounded-2xl border border-white/10 bg-white/5 p-2 backdrop-blur">
            <h2 id="signed-in-accounts" className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
              Signed in on this device
            </h2>
            <ul>
              {accounts.map((account) => (
                <li key={account.key}>
                  <button
                    type="button"
                    onClick={() => onContinue(account.key)}
                    disabled={switchingKey !== null}
                    aria-label={`Continue as ${account.label}`}
                    className="flex w-full items-center gap-3 rounded-xl p-3 text-left transition hover:bg-white/5 active:bg-white/10 disabled:opacity-60"
                  >
                    <AccountAvatar account={account} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-white">{account.label}</span>
                      {account.sublabel && <span className="block truncate text-xs text-gray-400">{account.sublabel}</span>}
                    </span>
                    <span className="shrink-0 text-xs font-semibold text-yellow-400">
                      {switchingKey === account.key ? "Opening…" : "Continue"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {recent.length > 0 && (
          <section aria-labelledby="recent-logins" className="mb-6">
            <h2 id="recent-logins" className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500">
              Used on this device before
            </h2>
            <ul className="flex flex-wrap gap-2">
              {recent.map((r) => (
                <li key={r.loginId} className="flex max-w-full items-center rounded-full border border-white/10 bg-white/5">
                  <button
                    type="button"
                    onClick={() => fillRemembered(r.loginId)}
                    aria-label={`Use ${r.loginId}`}
                    className="min-h-10 min-w-0 truncate rounded-l-full py-1.5 pl-3 pr-1 text-left text-xs text-gray-200 transition hover:text-white"
                  >
                    <span className="font-semibold">{r.label}</span>
                    {r.label !== r.loginId && <span className="text-gray-500"> · {r.loginId}</span>}
                  </button>
                  <button
                    type="button"
                    onClick={() => forgetLogin(r.loginId)}
                    aria-label={`Forget ${r.loginId}`}
                    className="flex h-10 w-9 shrink-0 items-center justify-center rounded-r-full text-gray-500 transition hover:text-white"
                  >
                    <NavIcon name="close" className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

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
                <label htmlFor="signin-identifier" className="block text-sm font-medium text-gray-300 mb-2">
                  Team ID or Admin Email
                </label>
                {/* `name` + `autoComplete` let the browser / OS password manager save each login
                    and offer them as a chooser — the safe way to keep credentials on a device. */}
                <input
                  id="signin-identifier"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={formData.identifier}
                  onChange={(e) => setFormData({ ...formData, identifier: e.target.value })}
                  className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-white placeholder-gray-500 focus:border-yellow-500 focus:outline-none focus:ring-1 focus:ring-yellow-500"
                  suppressHydrationWarning
                />
              </div>

              <div>
                <label htmlFor="signin-password" className="block text-sm font-medium text-gray-300 mb-2">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="signin-password"
                    name="password"
                    ref={passwordRef}
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
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
