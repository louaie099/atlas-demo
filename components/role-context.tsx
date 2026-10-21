"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { ROLES, UserRole } from "@/lib/roles";

const STORAGE_KEY = "atlas-demo-role";

interface RoleContextValue {
  role: UserRole;
  setRole: (role: UserRole) => void;
}

const RoleContext = createContext<RoleContextValue | null>(null);

/**
 * Demo-grade role context — see lib/roles.ts for what this is and isn't.
 * Defaults to "viewer" (the least-privileged role) so the permission
 * boundary is visible immediately rather than starting wide-open.
 */
export function RoleProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<UserRole>("viewer");

  // Restore the last-selected role after mount (not during the initial
  // render, so server and client markup agree). Per-browser convenience
  // only -- this demo role model is not authentication (see lib/roles.ts).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY) as UserRole | null;
      if (saved && ROLES.includes(saved)) setRoleState(saved);
    } catch {
      /* storage unavailable (private mode etc.) -- stay on the default */
    }
  }, []);

  function setRole(next: UserRole) {
    setRoleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  return <RoleContext.Provider value={{ role, setRole }}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within a RoleProvider");
  return ctx;
}
