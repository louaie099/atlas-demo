"use client";

import { createContext, Fragment, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { EmployeeDrawer } from "@/components/employees/employee-drawer";

/**
 * GLOBAL ENTITY LINKING (2026-10-21). Anywhere an agent or a flight is
 * named, it is a link to the closest place to read about it, so nobody has
 * to go hunting through other pages:
 *  - an agent name opens the same profile drawer People uses (qualifications,
 *    weekly schedule, history), as an overlay on whatever page you are on;
 *  - a flight code opens that flight's drawer on Live operations
 *    (/operations?flight=<code>).
 * One provider, mounted in the root layout, owns the single agent drawer.
 */

interface PersonRef {
  id: string;
  name: string;
}

interface EntityPanelValue {
  openAgent: (id: string) => void;
  people: PersonRef[];
}

const EntityPanelContext = createContext<EntityPanelValue | null>(null);

export function EntityPanelProvider({ children }: { children: ReactNode }) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [people, setPeople] = useState<PersonRef[]>([]);

  // Name list, used only to turn names inside free text (audit entries)
  // into links. Failure is harmless: text just stays unlinked.
  useEffect(() => {
    fetch("/api/employees", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { employees?: PersonRef[] }) => setPeople((d.employees ?? []).map((e) => ({ id: e.id, name: e.name }))))
      .catch(() => {});
  }, []);

  const value = useMemo(() => ({ openAgent: setAgentId, people }), [people]);

  return (
    <EntityPanelContext.Provider value={value}>
      {children}
      {agentId && (
        // Other drawers are z-40; this wrapper makes the profile open ABOVE
        // whichever drawer the user clicked the name from.
        <div className="relative z-50">
          <EmployeeDrawer employeeId={agentId} onClose={() => setAgentId(null)} />
        </div>
      )}
    </EntityPanelContext.Provider>
  );
}

const linkClass =
  "underline decoration-dotted decoration-1 underline-offset-2 hover:text-brand-700 hover:decoration-solid cursor-pointer";

export function AgentLink({
  id,
  name,
  className = "",
  children,
}: {
  id?: string;
  name: string;
  className?: string;
  children?: ReactNode;
}) {
  const ctx = useContext(EntityPanelContext);
  if (!ctx || !id) return <span className={className}>{children ?? name}</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        ctx.openAgent(id);
      }}
      title={`View ${name}'s profile`}
      className={`text-left ${linkClass} ${className}`}
    >
      {children ?? name}
    </button>
  );
}

export function flightHref(flight: string): string {
  return `/operations?flight=${encodeURIComponent(flight)}`;
}

export function FlightLink({
  flight,
  className = "",
  children,
}: {
  /** Flight number (e.g. "AT501") or flight id. */
  flight: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Link href={flightHref(flight)} onClick={(e) => e.stopPropagation()} title={`Open ${flight} in Live operations`} className={`${linkClass} ${className}`}>
      {children ?? flight}
    </Link>
  );
}

const FLIGHT_CODE = "\\b[A-Z0-9]{2}\\d{3,4}\\b";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Renders free text with every known agent name and flight code turned into a link. */
export function LinkedText({ text }: { text: string }) {
  const ctx = useContext(EntityPanelContext);
  const people = ctx?.people ?? [];
  const parts = useMemo(() => {
    const names = [...people].sort((a, b) => b.name.length - a.name.length).map((p) => escapeRegExp(p.name));
    const re = new RegExp(`(${names.length ? names.join("|") + "|" : ""}${FLIGHT_CODE})`, "g");
    return text.split(re);
  }, [text, people]);
  const byName = useMemo(() => new Map(people.map((p) => [p.name, p.id])), [people]);

  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        const id = byName.get(part);
        if (id) return <AgentLink key={i} id={id} name={part} />;
        if (new RegExp(`^${FLIGHT_CODE}$`).test(part)) return <FlightLink key={i} flight={part} />;
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
