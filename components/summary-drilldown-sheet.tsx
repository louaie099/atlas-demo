"use client";

import { useMemo, useState } from "react";
import { Flight, RosterRequirementView } from "@/lib/types";
import { ZoneCoverageView } from "@/lib/planning/persisted-plan-view";
import { PlanIssue, PlanIssueType } from "@/lib/planning/validation";
import { CHECKIN_ZONES } from "@/lib/checkin-zones";
import { Badge, Button } from "./ui";

export type SummaryMetric = "flights" | "managed" | "covered" | "gaps" | "warnings" | "zoneCovered" | "zoneGaps";

const WARNING_LABELS: Partial<Record<PlanIssueType, string>> = {
  rest_violation: "Rest violation",
  weekly_hours_violation: "Weekly-hours violation",
  consecutive_off_violation: "Consecutive-OFF violation",
  cross_week_continuity_uncertain: "Cross-week continuity uncertain",
  separated_off_days: "Separated OFF days (recommendation)",
  consecutive_work_history_unknown: "Consecutive-day history unknown (info)",
  roster_target_shortfall: "Below own roster target (recommendation)",
};

function issueTone(type: PlanIssueType): "bad" | "warn" {
  return type === "rest_violation" || type === "weekly_hours_violation" || type === "consecutive_off_violation" ? "bad" : "warn";
}

/**
 * Progressive-disclosure drill-down for the 5 PlanningSummaryBar metrics
 * (Part 3) -- a slide-over panel, same visual language and mechanism as
 * FindAgentSheet, opened/closed from app/planning/page.tsx's own
 * useState, never a new top-level page. Summary -> click -> detail ->
 * operational action (Find Agent for a gap; real navigation to the
 * relevant Flight Schedule/Flight Coverage/Agent Schedule row for
 * everything else).
 */
export function SummaryDrilldownSheet({
  metric,
  flights,
  roster,
  issues,
  zoneCoverage,
  onClose,
  onFindAgent,
  onFindZoneAgent,
  onNavigateToFlight,
  onNavigateToWarning,
}: {
  metric: SummaryMetric;
  flights: Flight[];
  roster: RosterRequirementView[];
  issues: PlanIssue[];
  zoneCoverage: ZoneCoverageView[];
  onClose: () => void;
  onFindAgent: (requirementId: string) => void;
  onFindZoneAgent: (zoneRequirementId: string) => void;
  onNavigateToFlight: (flightId: string) => void;
  onNavigateToWarning: (issue: PlanIssue) => void;
}) {
  const [warningTypeFilter, setWarningTypeFilter] = useState<PlanIssueType | "all">("all");

  const gapViews = useMemo(() => roster.filter((v) => v.coverageStatus === "gap"), [roster]);
  const coveredViews = useMemo(() => roster.filter((v) => v.coverageStatus === "assigned"), [roster]);
  const managedFlightIds = useMemo(() => new Set(roster.map((v) => v.flight.id)), [roster]);
  // Rows with required: 0 are pure-surplus derived rows (idle capacity with
  // no real demand at that instant -- see checkin-capacity-timeline.ts) --
  // real rows but not a genuine demand-vs-coverage fact worth counting in
  // either bucket here.
  const meaningfulZoneRequirements = useMemo(() => zoneCoverage.filter((v) => v.required > 0), [zoneCoverage]);
  const zoneGapViews = useMemo(() => meaningfulZoneRequirements.filter((v) => v.gap > 0), [meaningfulZoneRequirements]);
  const zoneCoveredViews = useMemo(() => meaningfulZoneRequirements.filter((v) => v.gap <= 0), [meaningfulZoneRequirements]);

  const planWarningTypes: PlanIssueType[] = [
    "rest_violation",
    "weekly_hours_violation",
    "consecutive_off_violation",
    "cross_week_continuity_uncertain",
    "separated_off_days",
    "consecutive_work_history_unknown",
    "roster_target_shortfall",
  ];
  const planWarnings = useMemo(() => issues.filter((i) => planWarningTypes.includes(i.type)), [issues]);
  const filteredWarnings = useMemo(
    () => (warningTypeFilter === "all" ? planWarnings : planWarnings.filter((i) => i.type === warningTypeFilter)),
    [planWarnings, warningTypeFilter]
  );

  const titleByMetric: Record<SummaryMetric, string> = {
    flights: "Flights this week",
    managed: "Managed flights",
    covered: "Requirements covered (flight+role)",
    gaps: "Staffing gaps (flight+role)",
    warnings: "Plan warnings",
    zoneCovered: "T1 Check-in zone requirements covered",
    zoneGaps: "T1 Check-in zone staffing gaps",
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg h-full bg-surface shadow-softer border-l border-border overflow-y-auto p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">{titleByMetric[metric]}</h2>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        {metric === "gaps" && (
          <div className="flex flex-col gap-3">
            {gapViews.length === 0 && <p className="text-sm text-muted">No staffing gaps in this week's plan.</p>}
            {gapViews.map((v) => (
              <div key={v.requirement.id} className="rounded-xl border border-border bg-white p-4 flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm font-medium text-ink">
                    {v.flight.flight_number} · {v.flight.day_of_week} {v.flight.scheduled_departure}
                  </span>
                  <Badge tone="bad">Gap</Badge>
                </div>
                <p className="text-xs text-muted">
                  {v.coverageLabel} — required {v.requirement.total_requirement}, assigned{" "}
                  {v.assignedEmployees.length + v.proposedEmployees.length}, shortage {v.gap}
                </p>
                <p className="text-xs text-muted">{v.requirement.reasoning}</p>
                <Button
                  variant="secondary"
                  className="self-start mt-1"
                  onClick={() => {
                    onClose();
                    onFindAgent(v.requirement.id);
                  }}
                >
                  Find Agent
                </Button>
              </div>
            ))}
          </div>
        )}

        {metric === "zoneGaps" && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              A T1 Check-in ZONE requirement -- combined aggregate demand across every flight sharing that zone's counters at this
              time, distinct from a flight+role slot above (see lib/checkin-zones.ts).
            </p>
            {zoneGapViews.length === 0 && <p className="text-sm text-muted">No T1 Check-in zone staffing gaps in this week's plan.</p>}
            {zoneGapViews.map((v) => {
              const zone = CHECKIN_ZONES[v.zone];
              const covered = v.available + v.manuallyAssigned;
              return (
                <div key={v.id} className="rounded-xl border border-border bg-white p-4 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-sm font-medium text-ink">
                      {zone.label} · {v.dayOfWeek} {v.windowStart}–{v.windowEnd}
                    </span>
                    <Badge tone="bad">Gap</Badge>
                  </div>
                  <p className="text-xs text-muted">
                    Required {v.required} · Available {covered} · Gap {v.gap} · {zone.countersLabel}
                  </p>
                  {v.zoneRequirementId && (
                    <Button
                      variant="secondary"
                      className="self-start mt-1"
                      onClick={() => {
                        onClose();
                        onFindZoneAgent(v.zoneRequirementId!);
                      }}
                    >
                      Find Agent
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {metric === "zoneCovered" && (
          <div className="flex flex-col gap-3">
            {zoneCoveredViews.length === 0 && <p className="text-sm text-muted">No fully-covered T1 Check-in zone requirements yet.</p>}
            {zoneCoveredViews.map((v) => {
              const zone = CHECKIN_ZONES[v.zone];
              const covered = v.available + v.manuallyAssigned;
              return (
                <div key={v.id} className="rounded-xl border border-border bg-white p-4 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-sm font-medium text-ink">
                      {zone.label} · {v.dayOfWeek} {v.windowStart}–{v.windowEnd}
                    </span>
                    <Badge tone="good">Covered</Badge>
                  </div>
                  <p className="text-xs text-muted">
                    {covered}/{v.required}: {[...v.manuallyAssignedEmployees, ...v.availableEmployees].map((e) => e.name).join(", ")}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {metric === "warnings" && (
          <div className="flex flex-col gap-3">
            <select
              value={warningTypeFilter}
              onChange={(e) => setWarningTypeFilter(e.target.value as PlanIssueType | "all")}
              className="text-sm border border-border rounded-lg px-2 py-1.5 bg-white text-ink self-start"
            >
              <option value="all">All warning types ({planWarnings.length})</option>
              {planWarningTypes.map((t) => (
                <option key={t} value={t}>
                  {WARNING_LABELS[t]} ({planWarnings.filter((i) => i.type === t).length})
                </option>
              ))}
            </select>
            {filteredWarnings.length === 0 && <p className="text-sm text-muted">No warnings of this type.</p>}
            {filteredWarnings.map((issue, i) => (
              <button
                key={`${issue.type}-${issue.employeeId ?? issue.requirementId}-${issue.dayOfWeek}-${i}`}
                type="button"
                onClick={() => {
                  onClose();
                  onNavigateToWarning(issue);
                }}
                className="text-left rounded-xl border border-border bg-white p-4 flex flex-col gap-1.5 hover:bg-gray-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <Badge tone={issueTone(issue.type)}>{WARNING_LABELS[issue.type] ?? issue.type}</Badge>
                  {issue.dayOfWeek && <span className="text-xs text-muted">{issue.dayOfWeek}</span>}
                </div>
                <p className="text-xs text-ink">{issue.description}</p>
                <span className="text-xs text-brand-700">
                  {issue.employeeId ? "Open in Agent Schedule →" : issue.requirementId ? "Open in Flight Coverage →" : ""}
                </span>
              </button>
            ))}
          </div>
        )}

        {metric === "covered" && (
          <div className="flex flex-col gap-3">
            {coveredViews.length === 0 && <p className="text-sm text-muted">No fully-covered requirements yet.</p>}
            {coveredViews.map((v) => (
              <button
                key={v.requirement.id}
                type="button"
                onClick={() => {
                  onClose();
                  onNavigateToFlight(v.flight.id);
                }}
                className="text-left rounded-xl border border-border bg-white p-4 flex flex-col gap-1.5 hover:bg-gray-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm font-medium text-ink">
                    {v.flight.flight_number} · {v.flight.day_of_week} {v.flight.scheduled_departure}
                  </span>
                  <Badge tone="good">Assigned</Badge>
                </div>
                <p className="text-xs text-muted">
                  {v.coverageLabel} — {v.assignedEmployees.length + v.proposedEmployees.length}/{v.requirement.total_requirement}:{" "}
                  {[...v.assignedEmployees, ...v.proposedEmployees].map((e) => e.name).join(", ")}
                </p>
                <span className="text-xs text-brand-700">Open in Flight Coverage →</span>
              </button>
            ))}
          </div>
        )}

        {(metric === "flights" || metric === "managed") && (
          <div className="flex flex-col gap-2">
            {flights
              .filter((f) => metric === "flights" || managedFlightIds.has(f.id))
              .map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    onClose();
                    onNavigateToFlight(f.id);
                  }}
                  className="text-left rounded-xl border border-border bg-white px-4 py-2.5 flex items-center gap-3 flex-wrap hover:bg-gray-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <span className="text-xs font-medium text-muted w-12 shrink-0">{f.scheduled_departure}</span>
                  <span className="font-semibold text-ink">{f.flight_number}</span>
                  <span className="text-sm text-ink">{f.route}</span>
                  <span className="text-sm text-muted">{f.day_of_week}</span>
                  {!managedFlightIds.has(f.id) && <Badge tone="neutral">Unmanaged</Badge>}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
