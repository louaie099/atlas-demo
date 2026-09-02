"use client";

import { createContext, useContext, useState, ReactNode } from "react";
import { UserRole } from "@/lib/roles";

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
  const [role, setRole] = useState<UserRole>("viewer");
  return <RoleContext.Provider value={{ role, setRole }}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within a RoleProvider");
  return ctx;
}
