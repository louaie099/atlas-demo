"use client";

import { ReactNode } from "react";
import { LiveOpsView } from "@/lib/live-ops-service";
import { LiveOpsFlightState } from "@/lib/live-ops-flight-state";

export type FlightFilter = "all" | "covered" | "atRisk" | "needsAction";

const FILTER_LABEL: Record<FlightFilter, string> = {
  all: "Flights",
  covered: "Covered",
  atRisk: "At Risk",
  needsAction: "Needs Action",
};

function countFor(filter: FlightFilter, states: LiveOpsFlightState[]): number {
  switch (filter) {
    case "all":
      return states.length;
    case "covered":
      return states.filter((s) => s === "covered").length;
    case "atRisk":
      return states.filter((s) => s === "delayed").length;
    case "needsAction":
      return states.filter((s) => s === "gap" || s === "conflict").length;
  }
}

/**
 * Compact Live Operations header (redesign section 2). The four flight
 * counters are clickable filters over the board below; the three
 * workforce counters are informational context only in this pass — the
 * full operational Agents view (clicking "Available" to open/filter the
 * workforce) is P1, explicitly deferred per the spec's own priority order
 * ("if time is tight, do not sacrifice P0 work"). See the delivered
 * report for this as a stated scope decision, not an oversight.
 */
export function LiveOpsHeader({
  date,
  view,
  states,
  activeFilter,
  onFilterChange,
  rightSlot,
}: {
  date: string;
  view: LiveOpsView;
  states: LiveOpsFlightState[];
  activeFilter: FlightFilter;
  onFilterChange: (filter: FlightFilter) => void;
  rightSlot?: ReactNode;
}) {
  const filters: FlightFilter[] = ["all", "covered", "atRisk", "needsAction"];

  return (
    <div className="bg-card border border-border rounded-xl2 shadow-soft px-5 py-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xs font-semibold tracking-wide text-muted uppercase">Live Operations</h1>
          <p className="text-lg font-semibold text-ink mt-0.5">{date}</p>
        </div>
        {rightSlot}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {filters.map((f) => {
          const count = countFor(f, states);
          const active = activeFilter === f;
          const toneClass =
            f === "needsAction" && count > 0
              ? "border-bad-500/40 text-bad-700 bg-bad-50"
              : f === "atRisk" && count > 0
              ? "border-warn-500/40 text-warn-700 bg-warn-50"
              : "border-border text-ink bg-surface";
          return (
            <button
              key={f}
              type="button"
              onClick={() => onFilterChange(active ? "all" : f)}
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition ${toneClass} ${
                active ? "ring-2 ring-brand-500/50" : "hover:bg-gray-50"
              }`}
            >
              <span className="font-semibold">{count}</span>
              <span className="text-xs">{FILTER_LABEL[f]}</span>
            </button>
          );
        })}

        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        <span className="text-xs text-muted flex items-center gap-3">
          <span>
            Agents working <span className="font-semibold text-ink">{view.workforce.workingToday}</span>
          </span>
          <span>
            Available <span className="font-semibold text-ink">{view.workforce.availableToday}</span>
          </span>
          <span>
            Assigned <span className="font-semibold text-ink">{view.workforce.assignedToday}</span>
          </span>
        </span>
      </div>
    </div>
  );
}
