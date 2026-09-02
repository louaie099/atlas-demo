"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ResetDemoButton } from "./reset-demo-button";
import { useRole } from "./role-context";
import { ROLES, ROLE_LABELS, UserRole } from "@/lib/roles";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/planning", label: "Weekly Planning" },
  { href: "/operations", label: "Live Operations" },
  { href: "/employees", label: "Employees" },
  { href: "/audit", label: "Audit Trail" },
];

function RoleSwitcher() {
  const { role, setRole } = useRole();
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      Viewing as
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as UserRole)}
        className="border border-border rounded-lg px-2 py-1 text-xs text-ink bg-white"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function NavBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-border">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center justify-between">
          <span className="text-lg font-semibold text-ink tracking-tight">
            Atlas <span className="text-brand-600">·</span>{" "}
            <span className="text-muted font-normal text-sm">CMN Operations</span>
          </span>
          <div className="sm:hidden flex items-center gap-2">
            <RoleSwitcher />
            <ResetDemoButton />
          </div>
        </div>

        <nav className="flex flex-wrap gap-1 sm:gap-2">
          {links.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                  active ? "bg-brand-50 text-brand-700" : "text-muted hover:text-ink hover:bg-gray-50"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden sm:flex items-center gap-3">
          <RoleSwitcher />
          <ResetDemoButton />
        </div>
      </div>
    </header>
  );
}
