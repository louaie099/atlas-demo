"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ResetDemoButton } from "./reset-demo-button";

const links = [
  { href: "/", label: "Dashboard" },
  { href: "/planning", label: "Weekly Planning" },
  { href: "/operations", label: "Live Operations" },
  { href: "/employees", label: "Employees" },
  { href: "/audit", label: "Audit Trail" },
];

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
          <div className="sm:hidden">
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

        <div className="hidden sm:block">
          <ResetDemoButton />
        </div>
      </div>
    </header>
  );
}
