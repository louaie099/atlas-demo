"use client";

import { useState } from "react";
import { Flight, RosterRequirementView } from "@/lib/types";
import { Badge, Button } from "./ui";
import { TeamBadge } from "./team-badge";

const statusTone = {
  covered: "good",
  proposed: "brand",
  gap: "bad",
  conflict: "bad",
  needs_configuration: "config",
} as const;

const statusLabel = {
  covered: "Confirmed",
  proposed: "Proposed",
  gap: "Staffing Gap",
  conflict: "Conflict",
  needs_configuration: "Needs Configuration",
} as const;

/**
 * One requirement's full detail -- required headcount, confirmed/proposed
 * employees, reasoning, and (for a genuine staffing gap only) the Find
 * Agent action. Lives inside a flight row's expanded area; also the unit
 * this whole file used to render as an oversized top-level card before
 * the flight-row redesign -- the content itself is unchanged, just
 * recontainered.
 */
export function RequirementDetail({
  view,
  onFindAgent,
}: {
  view: RosterRequirementView;
  onFindAgent: (requirementId: string) => void;
}) {
  const { requirement, assignedEmployees, proposedEmployees, coverageStatus } = view;

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface px-3 py-2.5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="text-sm">
          <span className="font-medium text-ink">{requirement.role}</span>
          {!requirement.needs_configuration && (
            <span className="text-muted">
              {" "}
              -- {assignedEmployees.length + proposedEmployees.length}/{requirement.total_requirement}
              {requirement.source === "demand_forecast" &&
                ` (baseline ${requirement.baseline_requirement} + reinforcement ${requirement.additional_requirement})`}
            </span>
          )}
        </div>
        <Badge tone={statusTone[coverageStatus]}>{statusLabel[coverageStatus]}</Badge>
      </div>

      <p className="text-xs text-muted">{requirement.reasoning}</p>

      {!requirement.needs_configuration && (
        <div className="flex flex-wrap gap-1.5">
          {assignedEmployees.map((e) => (
            <span key={e.id} className="text-xs bg-gray-100 text-ink px-2.5 py-1 rounded-full">
              {e.name}
            </span>
          ))}
          {proposedEmployees.map((e) => (
            <span key={e.id} className="text-xs bg-brand-50 text-brand-700 px-2.5 py-1 rounded-full">
              {e.name} - proposed
            </span>
          ))}
          {assignedEmployees.length === 0 && proposedEmployees.length === 0 && (
            <span className="text-xs text-muted">No one available yet</span>
          )}
        </div>
      )}

      {coverageStatus === "gap" && (
        <Button onClick={() => onFindAgent(requirement.id)} className="self-start" variant="secondary">
          Find Agent
        </Button>
      )}
    </div>
  );
}

/**
 * The compact, at-a-glance summary for one requirement, shown in the
 * collapsed flight row -- never a full breakdown, just enough to scan.
 * Uses the requirement's own role name (Gate/Boarding/.../Ramp Team) --
 * never RAM terminology forced onto a foreign flight's Ramp Team
 * requirement, since `requirement.role` already carries the right label
 * for whichever kind of flight this is.
 */
function RequirementChip({ view }: { view: RosterRequirementView }) {
  const { requirement, assignedEmployees, proposedEmployees, coverageStatus } = view;

  if (requirement.needs_configuration) {
    return <Badge tone="config">Needs Configuration - {requirement.role}</Badge>;
  }

  const covered = assignedEmployees.length + proposedEmployees.length;
  const tone = statusTone[coverageStatus];

  return (
    <Badge tone={tone}>
      {requirement.role} {covered}/{requirement.total_requirement}
    </Badge>
  );
}

/**
 * One compact row per flight -- the unit Flight Coverage is now organized
 * around, instead of one oversized card per requirement. Chronological
 * scanning: time, flight identity, operator/company identity (via the
 * existing centralized team-color system -- a foreign carrier gets its own
 * color, RAM/Royal Air Maroc gets the calm neutral fallback automatically,
 * no special-casing needed), then a compact requirement summary. Click to
 * expand into the full per-requirement detail -- same content
 * (RequirementDetail above), no separate dataset.
 */
export function FlightCoverageRow({
  flight,
  views,
  onFindAgent,
}: {
  flight: Flight;
  views: RosterRequirementView[];
  onFindAgent: (requirementId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-card border border-border rounded-xl2 shadow-soft overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex flex-col gap-2 px-4 py-3 text-left hover:bg-surface"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium text-muted w-12 shrink-0">{flight.scheduled_departure}</span>
          <span className="font-semibold text-ink">{flight.flight_number}</span>
          <span className="text-sm text-ink">{flight.route}</span>
          <span className="text-sm text-muted">{flight.aircraft}</span>
          <TeamBadge name={flight.airline} />
          {flight.destination_category && (
            <span className="text-xs text-muted">{flight.destination_category}</span>
          )}
          <span className="ml-auto text-xs text-muted">{expanded ? "Hide detail (collapse)" : "Detail (expand)"}</span>
        </div>

        <div className="flex flex-wrap gap-1.5 pl-[3.75rem]">
          {views.map((v) => (
            <RequirementChip key={v.requirement.id} view={v} />
          ))}
        </div>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-border bg-surface/60 px-4 py-3">
          {views.map((v) => (
            <RequirementDetail key={v.requirement.id} view={v} onFindAgent={onFindAgent} />
          ))}
        </div>
      )}
    </div>
  );
}
