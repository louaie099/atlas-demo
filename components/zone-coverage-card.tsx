"use client";

import { useEffect, useRef, useState } from "react";
import { ZoneCoverageView } from "@/lib/planning/persisted-plan-view";
import { CHECKIN_ZONES } from "@/lib/checkin-zones";
import { Badge, Button } from "./ui";

/**
 * T1 Check-in ZONE coverage -- a genuinely separate section from the
 * per-flight Flight Coverage rows above it (FlightCoverageRow in
 * flight-coverage-card.tsx, UNCHANGED), because Check-in is no longer a
 * per-flight requirement (see lib/checkin-zones.ts's module doc comment).
 * One row per zone/time-window requirement, with a drill-down into the
 * real flights whose combined workload produced that number -- never a
 * single merged "Check-in" number across the whole day.
 */
export function ZoneCoverageRow({
  view,
  onFindAgent,
}: {
  view: ZoneCoverageView;
  onFindAgent: (zoneRequirementId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { requirement, assignedEmployees, proposedEmployees, gap, contributingFlights } = view;
  const zone = CHECKIN_ZONES[requirement.zone];
  const covered = assignedEmployees.length + proposedEmployees.length;
  const tone = gap > 0 ? "bad" : "good";

  return (
    <div className="bg-card border border-border rounded-xl2 shadow-soft overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex flex-col gap-1.5 px-4 py-3 text-left hover:bg-surface"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs font-medium text-muted w-28 shrink-0">
            {requirement.window_start}–{requirement.window_end}
          </span>
          <span className="font-semibold text-ink">{zone.label}</span>
          <span className="text-sm text-muted">{zone.countersLabel}</span>
          {requirement.source === "manual" && <Badge tone="neutral">Manual</Badge>}
          <Badge tone={tone}>
            Required {requirement.required_headcount} · Assigned {covered} · Gap {gap}
          </Badge>
          <span className="ml-auto text-xs text-muted">
            {contributingFlights.length} contributing flight{contributingFlights.length === 1 ? "" : "s"} {expanded ? "(hide)" : "(show)"}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-border bg-surface/60 px-4 py-3">
          <p className="text-xs text-muted">{requirement.reasoning}</p>

          <div className="flex flex-wrap gap-1.5">
            {assignedEmployees.map((e) => (
              <span key={e.id} className="text-xs bg-gray-100 text-ink px-2.5 py-1 rounded-full">
                {e.name}
              </span>
            ))}
            {proposedEmployees.map((e) => (
              <span key={e.id} className="text-xs bg-brand-50 text-brand-700 px-2.5 py-1 rounded-full">
                {e.name}
              </span>
            ))}
            {covered === 0 && <span className="text-xs text-muted">No one positioned here yet</span>}
          </div>

          {contributingFlights.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wide">Contributing flights</h4>
              <div className="flex flex-col gap-1">
                {contributingFlights.map((f) => (
                  <div key={f.id} className="text-xs text-muted flex items-center gap-2">
                    <span className="font-medium text-ink">{f.flight_number}</span>
                    <span>{f.route}</span>
                    <span>departs {f.scheduled_departure}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {gap > 0 && (
            <Button onClick={() => onFindAgent(requirement.id)} className="self-start" variant="secondary">
              Find Agent
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** One day's worth of zone coverage rows -- same day-grouping shape Flight Coverage already uses for flights. */
export function ZoneCoverageSection({
  day,
  views,
  onFindAgent,
  focus,
}: {
  day: string;
  views: ZoneCoverageView[];
  onFindAgent: (zoneRequirementId: string) => void;
  focus?: { zoneRequirementId: string; token: number } | null;
}) {
  const sectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focus) return;
    if (!views.some((v) => v.requirement.id === focus.zoneRequirementId)) return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.zoneRequirementId, focus?.token]);

  if (views.length === 0) return null;

  return (
    <div ref={sectionRef} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">{day} · T1 Check-in Zones</h2>
      <div className="flex flex-col gap-2">
        {views.map((v) => (
          <ZoneCoverageRow key={v.requirement.id} view={v} onFindAgent={onFindAgent} />
        ))}
      </div>
    </div>
  );
}
