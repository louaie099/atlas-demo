"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { ROLES, UserRole } from "@/lib/roles";

const STORAGE_KEY = "atlas-demo-role";
const DEMO_MODE = process.env.NEXT_PUBLIC_ATLAS_DEMO_MODE === "true";

interface RoleContextValue {
  role: UserRole;
  /**
   * Only has any effect when signed out AND this deployment has
   * NEXT_PUBLIC_ATLAS_DEMO_MODE=true -- the client-side half of the demo
   * role switcher. Once a real session exists, role comes from the server
   * (see lib/resolve-role.ts) and this is a no-op: the browser cannot
   * change what the server trusts.
   */
  setRole: (role: UserRole) => void;
  /** Whether /api/me found a real, signed-in Supabase Auth session. */
  authenticated: boolean;
  email: string | null;
  /** Mirrors NEXT_PUBLIC_ATLAS_DEMO_MODE -- lets the UI decide whether to show the demo role switcher at all. */
  demoMode: boolean;
  /** True until the initial /api/me check resolves. */
  loading: boolean;
}

const RoleContext = createContext<RoleContextValue | null>(null);

/**
 * Real identity now comes from the server (GET /api/me, which reads the
 * httpOnly Supabase Auth session cookie -- see lib/auth-server.ts). This
 * context's old job -- a purely client-side "pretend to be this role"
 * toggle -- still exists, but ONLY as a demo convenience, and only when
 * both of these hold: nobody is actually signed in, and this deployment
 * opted in to NEXT_PUBLIC_ATLAS_DEMO_MODE=true. Everywhere else, the
 * role shown here is exactly the role the server will enforce -- there is
 * no longer a gap between "what the UI claims" and "what a route handler
 * will actually allow".
 *
 * Defaults to "viewer" (the least-privileged role) while loading and
 * whenever nothing else applies, so the permission boundary is visible
 * immediately rather than starting wide-open.
 */
export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<UserRole>("viewer");
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the last-selected DEMO role after mount (not during the initial
  // render, so server and client markup agree). Per-browser convenience
  // only, and only ever a starting point: the /api/me check below always
  // has the last word once it resolves, since a real session's role is
  // never something the browser gets to override.
  useEffect(() => {
    if (!DEMO_MODE) return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as UserRole | null;
      if (saved && (ROLES as string[]).includes(saved)) setRoleState(saved);
    } catch {
      /* storage unavailable (private mode etc.) -- stay on the default */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        setAuthenticated(Boolean(data.authenticated));
        setEmail(data.email ?? null);
        // A real session's role always wins over whatever the demo
        // localStorage restore above set a moment earlier.
        if (data.authenticated) setRoleState(data.role ?? "viewer");
      })
      .catch(() => {
        // /api/me failing (e.g. Supabase Auth not configured in this
        // environment) should never break the app -- fall back to the
        // safe default and, if demo mode is on, let the switcher take over.
        if (!cancelled) setAuthenticated(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function setRole(next: UserRole) {
    if (authenticated || !DEMO_MODE) return;
    setRoleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore -- per-browser convenience only */
    }
  }

  return (
    <RoleContext.Provider
      value={{ role, setRole, authenticated, email, demoMode: DEMO_MODE, loading }}
    >
      {children}
    </RoleContext.Provider>
  );
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within a RoleProvider");
  return ctx;
}
