"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type Mode = "password" | "magic-link";

/**
 * Real sign-in page, backed by Supabase Auth -- the first concrete piece of
 * Phase 1 (see docs/known-limitations/auth-and-rls.md). This replaces
 * "whoever can reach the URL can act as any role" with an actual account:
 * once signed in, the session cookie is what app/api/* routes trust (via
 * lib/resolve-role.ts), never a client-supplied header.
 *
 * Deliberately minimal: email/password, or a magic link for a project
 * that hasn't set a password yet. No sign-up form here on purpose --
 * accounts for a real pilot should be provisioned by an administrator
 * (via the Supabase dashboard or an invite flow), not self-registered.
 */
export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus("working");
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        setStatus("idle");
        return;
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in is not configured in this environment.");
      setStatus("idle");
    }
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus("working");
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (otpError) {
        setError(otpError.message);
        setStatus("idle");
        return;
      }
      setStatus("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in is not configured in this environment.");
      setStatus("idle");
    }
  }

  return (
    <div className="max-w-sm mx-auto mt-12">
      <Card className="p-6 flex flex-col gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink">Sign in to Atlas</h1>
          <p className="text-sm text-muted mt-1">
            Your role (Viewer / Planner / Administrator) is assigned to your account by an
            administrator -- it is no longer chosen in the browser.
          </p>
        </div>

        <div className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={() => setMode("password")}
            className={`px-2.5 py-1 rounded-lg ${
              mode === "password" ? "bg-brand-50 text-brand-700" : "text-muted hover:bg-gray-50"
            }`}
          >
            Password
          </button>
          <button
            type="button"
            onClick={() => setMode("magic-link")}
            className={`px-2.5 py-1 rounded-lg ${
              mode === "magic-link" ? "bg-brand-50 text-brand-700" : "text-muted hover:bg-gray-50"
            }`}
          >
            Email link
          </button>
        </div>

        {mode === "password" ? (
          <form onSubmit={handlePasswordSignIn} className="flex flex-col gap-3">
            <input
              type="email"
              required
              placeholder="you@ramhandling.example"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border border-border rounded-lg px-3 py-2 text-sm"
            />
            <input
              type="password"
              required
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border border-border rounded-lg px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={status === "working"}
              className="bg-brand-600 text-white rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
            >
              {status === "working" ? "Signing in..." : "Sign in"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleMagicLink} className="flex flex-col gap-3">
            <input
              type="email"
              required
              placeholder="you@ramhandling.example"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border border-border rounded-lg px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={status === "working" || status === "sent"}
              className="bg-brand-600 text-white rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
            >
              {status === "sent" ? "Check your email" : status === "working" ? "Sending..." : "Send sign-in link"}
            </button>
            {status === "sent" && (
              <p className="text-xs text-muted">
                We sent a sign-in link to {email}. Open it on this device to finish signing in.
              </p>
            )}
          </form>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </Card>
    </div>
  );
}
