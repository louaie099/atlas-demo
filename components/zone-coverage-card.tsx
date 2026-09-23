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
 *
 * 2026-09-23: the badge changed from "Required X · Assigned Y · Gap Z" to
 * "Required X · Available Y · Gap/Surplus Z" -- "Assigned" implied a
 * discrete duty assignment, which no longer exists for automatic default
 * placement (see lib/planning/checkin-capacity-timeline.ts). "Available"
 * is a real, derived capacity number computed at read time from the
 * roster + already-persisted specific-duty intervals, never a count of
 * persisted assignment rows. A genuine human Find-Agent commitment still
 * shows separately as "Manually assigned" and still reduces the gap.
 */
export function ZoneCoverageRow({
  view,
  onFindAgent,
}: {
  view: ZoneCoverageView;
  onFindAgent: (zoneRequirementId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { zone: zoneId, required, available, manuallyAssigned, gap, surplus, contributingFlights, availableEmployees, manuallyAssignedEmployees, reasoning, zoneRequirementId } = view;
  const zone = CHECKIN_ZONES[zoneId];
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
            {view.windowStart}–{view.windowEnd}
          </span>
          <span className="font-semibold text-ink">{zone.label}</span>
          <span className="text-sm text-muted">{zone.countersLabel}</span>
          <Badge tone={tone}>
            Required {required} · Available {available + manuallyAssigned} · {gap > 0 ? `Gap ${gap}` : `Surplus ${surplus}`}
          </Badge>
          <span className="ml-auto text-xs text-muted">
            {contributingFlights.length} contributing flight{contributingFlights.length === 1 ? "" : "s"} {expanded ? "(hide)" : "(show)"}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 border-t border-border bg-surface/60 px-4 py-3">
          <p className="text-xs text-muted">{reasoning}</p>

          <div className="flex flex-wrap gap-1.5">
            {manuallyAssignedEmployees.map((e) => (
              <span key={e.id} className="text-xs bg-gray-100 text-ink px-2.5 py-1 rounded-full">
                {e.name} (manually assigned)
              </span>
            ))}
            {availableEmployees.map((e) => (
              <span key={e.id} className="text-xs bg-brand-50 text-brand-700 px-2.5 py-1 rounded-full">
                {e.name}
              </span>
            ))}
            {available + manuallyAssigned === 0 && <span className="text-xs text-muted">No one positioned here yet</span>}
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

          {gap > 0 && zoneRequirementId && (
            <Button onClick={() => onFindAgent(zoneRequirementId)} className="self-start" variant="secondary">
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
    if (!views.some((v) => v.id === focus.zoneRequirementId || v.zoneRequirementId === focus.zoneRequirementId)) return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.zoneRequirementId, focus?.token]);

  if (views.length === 0) return null;

  return (
    <div ref={sectionRef} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">{day} · T1 Check-in Zones</h2>
      <div className="flex flex-col gap-2">
        {views.map((v) => (
          <ZoneCoverageRow key={v.id} view={v} onFindAgent={onFindAgent} />
        ))}
      </div>
    </div>
  );
}
