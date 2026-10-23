"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode } from "react";
import { ResetDemoButton } from "./reset-demo-button";
import { useRole } from "./role-context";
import { ROLES, ROLE_LABELS, UserRole } from "@/lib/roles";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const links: { href: string; label: string; icon: ReactNode }[] = [
  {
    href: "/",
    label: "Command center",
    icon: (
      <svg {...iconProps}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 12l5-5" />
        <circle cx="12" cy="12" r="1.5" />
      </svg>
    ),
  },
  {
    href: "/planning",
    label: "Planning",
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </svg>
    ),
  },
  {
    href: "/operations",
    label: "Live operations",
    icon: (
      <svg {...iconProps}>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </svg>
    ),
  },
  {
    href: "/employees",
    label: "People",
    icon: (
      <svg {...iconProps}>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" />
        <path d="M16 5.2a3.4 3.4 0 010 6.6M18 14.8c2 .6 3.3 2.4 3.6 5.2" />
      </svg>
    ),
  },
  {
    href: "/audit",
    label: "Audit trail",
    icon: (
      <svg {...iconProps}>
        <path d="M9 6h12M9 12h12M9 18h12" />
        <circle cx="4.5" cy="6" r="1" />
        <circle cx="4.5" cy="12" r="1" />
        <circle cx="4.5" cy="18" r="1" />
      </svg>
    ),
  },
];

function RoleSwitcher() {
  const { role, setRole, authenticated, demoMode } = useRole();

  // Once a real session exists, or this deployment hasn't opted into demo
  // mode, there is nothing for this control to do -- role comes from the
  // server (see lib/resolve-role.ts), and a client-side dropdown pretending
  // otherwise would be actively misleading.
  if (authenticated || !demoMode) return null;

  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      Viewing as
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as UserRole)}
        className="border border-border rounded-lg px-2 py-2 text-sm text-ink bg-white"
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

function RoleChip() {
  const { role } = useRole();
  return (
    <div className="mx-2 rounded-lg border border-navy-700 px-3 py-2 text-xs text-navy-dim">
      Viewing as <span className="font-semibold text-white">{ROLE_LABELS[role]}</span>
      {role === "viewer" && <span className="block mt-0.5">Read-only. Switch role in Demo tools to make changes.</span>}
    </div>
  );
}

/**
 * Real sign-in state -- see docs/known-limitations/auth-and-rls.md. Shows a
 * "Sign in" link when nobody's authenticated, or the signed-in email + the
 * server-resolved role (never the demo role) + a sign-out button once they
 * are. This is the one place in the sidebar that reflects what the SERVER
 * actually trusts, as distinct from RoleChip/RoleSwitcher's demo-only
 * client-side role, which only ever applies when signed out.
 */
function AuthStatus() {
  const router = useRouter();
  const { authenticated, email, role, loading } = useRole();

  if (loading) return null;

  if (!authenticated) {
    return (
      <Link
        href="/login"
        className="mx-2 flex items-center justify-center rounded-lg bg-white px-3 py-2 text-xs font-medium text-navy-900 hover:bg-gray-100"
      >
        Sign in
      </Link>
    );
  }

  async function handleSignOut() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="mx-2 flex flex-col gap-1.5 rounded-lg border border-navy-700 px-3 py-2 text-xs text-navy-dim">
      <span className="truncate" title={email ?? undefined}>
        {email} <span className="text-white font-medium">({ROLE_LABELS[role]})</span>
      </span>
      <button
        type="button"
        onClick={handleSignOut}
        className="self-start rounded-md border border-navy-700 px-2 py-1 text-navy-dim hover:bg-navy-800"
      >
        Sign out
      </button>
    </div>
  );
}

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-3 px-2 shrink-0">
      <svg width="32" height="32" viewBox="0 0 34 34" fill="none" stroke="#FFFFFF" strokeWidth="1.6" aria-hidden="true">
        <circle cx="17" cy="17" r="14" />
        <ellipse cx="17" cy="17" rx="6" ry="14" />
        <path d="M3 17h28M5.5 9.5h23M5.5 24.5h23" />
      </svg>
      <span className="flex flex-col leading-tight">
        <span className="text-[19px] font-bold text-white tracking-wide">Atlas</span>
        <span className="text-xs text-navy-dim">CMN Operations</span>
      </span>
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="bg-navy-900 lg:w-60 lg:shrink-0 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto flex flex-col gap-3 lg:gap-7 px-3 py-3 lg:px-4 lg:py-6">
      <Logo />
      <div className="hidden lg:flex lg:flex-col lg:gap-2 -mt-3">
        <AuthStatus />
        <RoleChip />
      </div>

      <nav aria-label="Primary" className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible">
        {links.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 whitespace-nowrap rounded-lg px-3 min-h-[44px] text-sm font-medium ${
                active ? "bg-navy-800 text-white" : "text-navy-text hover:bg-navy-800/60 hover:text-white"
              }`}
            >
              {link.icon}
              {link.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-3">
        <details className="group rounded-lg border border-navy-700">
          <summary className="cursor-pointer select-none list-none px-3 min-h-[44px] flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-navy-dim">
            Demo tools
            <span aria-hidden="true" className="group-open:rotate-180">
              ▾
            </span>
          </summary>
          <div className="bg-white rounded-lg m-2 p-3 flex flex-col gap-3">
            <RoleSwitcher />
            <ResetDemoButton />
          </div>
        </details>
      </div>
    </aside>
  );
}
