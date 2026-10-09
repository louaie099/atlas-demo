"use client";

import { useState } from "react";
import { LiveOpsFlightView, LiveOpsRequirementView } from "@/lib/live-ops-service";
import { FLIGHT_STATE_LABEL, LiveOpsFlightState } from "@/lib/live-ops-flight-state";
import { FLIGHT_PHASE_LABEL, resolveFlightPhase } from "@/lib/flight-phase";
import { canManageOperations } from "@/lib/roles";
import { useRole } from "./role-context";
import { Badge, Button } from "./ui";
import { TeamBadge } from "./team-badge";

/** What FlightOpsRow asks its parent to open — either Find Agent's own
 * "assign" mode against an uncovered requirement, or its "reassign" mode
 * against one specific currently-assigned/proposed employee. The parent
 * (app/operations/page.tsx) owns the sheet so it can be a single shared
 * instance across every row/requirement on the board. */
export type LiveOpsAssignRequest =
  | { mode: "assign"; requirementId: string; roleLabel: string }
  | { mode: "reassign"; requirementId: string; roleLabel: string; employeeId: string; employeeName: string };

// Reuses Flight Coverage's own status-to-tone convention
// (components/flight-coverage-card.tsx's statusTone) for per-requirement
// chips, so a requirement reads the same way in Monthly Planning and here.
const requirementTone = {
  assigned: "good",
  gap: "bad",
  conflict: "bad",
} as const;

const stateTone: Record<LiveOpsFlightState, "good" | "warn" | "bad" | "neutral"> = {
  covered: "good",
  delayed: "warn",
  gap: "bad",
  conflict: "bad",
};

/** Where the viewed date sits relative to today — decides whether the
 * flight's lifecycle phase can be live-computed at all (see FlightOpsRow's
 * own doc comment below). */
export type DayRelation = "past" | "today" | "future";

type DotColor = "gray" | "green" | "yellow" | "red";

const dotColorClass: Record<DotColor, string> = {
  gray: "bg-gray-400",
  green: "bg-good-500",
  yellow: "bg-warn-500",
  red: "bg-bad-500",
};

/**
 * One flight's compact Live Operations row. Calm/muted when fully covered
 * and on time (no badge at all -- nothing here needs attention); a visible
 * accent only appears for a flight that actually needs a look
 * (Gap/Delayed/Conflict), per the product's "scan-and-act, not a
 * dashboard" brief.
 */
export function FlightOpsRow({
  view,
  state,
  nowMinutesSinceMidnight,
  dayRelation,
  onEdit,
  onOpen,
  onOpenRequirement,
  onRequestAssign,
}: {
  view: LiveOpsFlightView;
  state: LiveOpsFlightState;
  // Minutes since midnight for "now," or null when the viewed date isn't
  // actually today -- in which case we never fabricate a live phase for a
  // day that isn't happening right now (see dayRelation below). Computed
  // once per page load/refresh in app/operations/page.tsx; a live-ticking
  // clock is a reasonable future enhancement, not needed for this demo.
  nowMinutesSinceMidnight: number | null;
  dayRelation: DayRelation;
  /** Opens the flight's operational drawer in edit mode directly (the
   * "Edit flight" button). */
  onEdit: () => void;
  /** Opens the flight's operational drawer in its default VIEW mode
   * (2026-10-06 — "everything meaningful should be clickable": the flight
   * number/whole row opens Flight Operational Details, never just the
   * edit form). */
  onOpen: () => void;
  /** Opens the drawer already focused on one specific staffing
   * requirement (clicking "Gate 0/2" jumps straight to that section). */
  onOpenRequirement?: (requirementId: string) => void;
  /** Opens the shared Find Agent/Reassign sheet for one requirement row
   * (2026-10-04 — every requirement row must be actionable: Assign for a
   * gap, Change for an already-covered one). Omit to render the board
   * read-only (not currently used, kept for a future read-only surface). */
  onRequestAssign?: (request: LiveOpsAssignRequest) => void;
}) {
  const { role } = useRole();
  const canAct = canManageOperations(role);
  const { flight, effectiveDeparture, requirements } = view;
  const departureChanged = effectiveDeparture !== flight.scheduled_departure;
  const calm = state === "covered";

  // A manual phase override always wins, even for a non-today date (e.g.
  // a DO correcting yesterday's record). `nowMinutesSinceMidnight ?? 0` is
  // a safe placeholder here -- resolveFlightPhase never consults "now"
  // once an override is set.
  const resolved = resolveFlightPhase(flight, effectiveDeparture, nowMinutesSinceMidnight ?? 0);

  let phaseLabel: string;
  let phaseIsDeparted: boolean;
  let live: boolean; // whether the dot/label reflect a real computed phase (vs. a flat past/future placeholder)

  if (resolved.isManualOverride || nowMinutesSinceMidnight !== null) {
    phaseLabel = FLIGHT_PHASE_LABEL[resolved.phase];
    phaseIsDeparted = resolved.phase === "departed";
    live = true;
  } else if (dayRelation === "past") {
    phaseLabel = FLIGHT_PHASE_LABEL.departed;
    phaseIsDeparted = true;
    live = false;
  } else {
    phaseLabel = "Scheduled";
    phaseIsDeparted = false;
    live = false;
  }

  // Dot color/animation: departed is always a flat gray dot (nothing left
  // to watch), a non-live placeholder (future date, no override) is also
  // flat gray; otherwise urgency comes from the SAME LiveOpsFlightState
  // this row already shows a badge for -- never duplicated logic. Per the
  // product owner's own words, "operating flights should appear with a
  // flashing green light."
  let dotColor: DotColor;
  let pulsing: boolean;
  if (phaseIsDeparted || !live) {
    dotColor = "gray";
    pulsing = false;
  } else if (state === "conflict" || state === "gap") {
    dotColor = "red";
    pulsing = true;
  } else if (state === "delayed") {
    dotColor = "yellow";
    pulsing = true;
  } else {
    dotColor = "green";
    pulsing = true;
  }

  return (
    <div
      className={`bg-card border rounded-xl2 shadow-soft overflow-hidden ${
        calm ? "border-border" : "border-bad-500/30"
      }`}
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${dotColorClass[dotColor]} ${pulsing ? "animate-pulse" : ""}`}
            aria-hidden="true"
          />
          <button
            type="button"
            onClick={onOpen}
            className="font-semibold text-ink hover:underline underline-offset-2 decoration-dotted"
          >
            {flight.flight_number}
          </button>
          <button type="button" onClick={onOpen} className="text-sm text-ink hover:underline underline-offset-2 decoration-dotted">
            {flight.destination ?? flight.route}
          </button>
          <TeamBadge name={flight.airline} />
          <span className="text-xs text-muted">{flight.aircraft}</span>

          <span className="text-xs text-muted">
            Scheduled {flight.scheduled_departure}
            {departureChanged && (
              <span className="ml-1.5 font-medium text-warn-700">· Current {effectiveDeparture}</span>
            )}
          </span>

          {/* Phase label stays muted/neutral always -- only the dot's color
              and pulsing communicate urgency, so this is visible for every
              flight without reading as another alert. */}
          <span className="text-xs text-muted">{phaseLabel}</span>

          {flight.gate && <span className="text-xs text-muted">Gate {flight.gate}</span>}

          {!calm && <Badge tone={stateTone[state]}>{FLIGHT_STATE_LABEL[state]}</Badge>}

          <Button variant="ghost" className="ml-auto !px-2 !py-1 !shadow-none" onClick={onEdit}>
            Edit flight
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          {requirements.map((r) => {
            const totalCovered = r.assignedEmployees.length + r.proposedEmployees.length;
            const hasGap = totalCovered < r.requirement.total_requirement;
            return (
              <div key={r.requirement.id} className="flex flex-col gap-1 rounded-lg bg-surface px-3 py-1.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <button
                  type="button"
                  onClick={() => onOpenRequirement?.(r.requirement.id)}
                  className="text-ink hover:underline underline-offset-2 decoration-dotted text-left"
                >
                  {r.coverageLabel} <span className="text-muted">{totalCovered}/{r.requirement.total_requirement}</span>
                </button>
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {totalCovered === 0 ? (
                    <span className="text-xs text-muted">— gap —</span>
                  ) : (
                    <>
                      {r.assignedEmployees.map((e) => (
                        <EmployeeChip
                          key={e.id}
                          name={e.name}
                          tone="assigned"
                          canAct={canAct}
                          onReassign={
                            onRequestAssign
                              ? () =>
                                  onRequestAssign({
                                    mode: "reassign",
                                    requirementId: r.requirement.id,
                                    roleLabel: r.coverageLabel,
                                    employeeId: e.id,
                                    employeeName: e.name,
                                  })
                              : undefined
                          }
                        />
                      ))}
                      {/* ATLAS's own generated picks -- a normal part of
                          the plan, not a pending recommendation, so this
                          uses the same calm brand-blue treatment Flight
                          Coverage uses, never a "needs approval" styling.
                          Still a real, reassignable Assignment row (source
                          "atlas_generated" rather than "human_modified" —
                          see lib/live-ops-service.ts), so it gets the same
                          Change action as a human-assigned one. */}
                      {r.proposedEmployees.map((e) => (
                        <EmployeeChip
                          key={e.id}
                          name={e.name}
                          tone="proposed"
                          canAct={canAct}
                          onReassign={
                            onRequestAssign
                              ? () =>
                                  onRequestAssign({
                                    mode: "reassign",
                                    requirementId: r.requirement.id,
                                    roleLabel: r.coverageLabel,
                                    employeeId: e.id,
                                    employeeName: e.name,
                                  })
                              : undefined
                          }
                        />
                      ))}
                    </>
                  )}
                  {hasGap && onRequestAssign && (
                    <Button
                      variant="secondary"
                      disabled={!canAct}
                      className="!px-2 !py-1 !text-xs !shadow-none"
                      onClick={() =>
                        onRequestAssign({ mode: "assign", requirementId: r.requirement.id, roleLabel: r.coverageLabel })
                      }
                    >
                      Assign agent
                    </Button>
                  )}
                  <Badge tone={requirementTone[r.coverageStatus]}>{r.coverageStatus}</Badge>
                </div>
              </div>
              <GapTriageDetail requirementView={r} />
              </div>
            );
          })}
          {requirements.length === 0 && <p className="text-xs text-muted">No staffing requirements for this flight.</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Gap-triage strip for one requirement row (2026-10-09, Live Operations
 * gap classification). Surfaces, without ever acting on its own, the
 * three distinctions a regulator needs when a requirement isn't simply
 * "covered":
 *  1. an unfilled requirement WITH a real eligible candidate ("Resolvable")
 *  2. an unfilled requirement with no eligible candidate at all ("No
 *     eligible employee" — the honest exclusion breakdown is one click
 *     away, the exact same reasons Find Agent's own empty state shows)
 *  3. a requirement that reads as fully covered by headcount but whose
 *     current occupant's duty was invalidated by a flight-time change
 *     ("Invalidated by flight change")
 * Never assigns anyone and never hides a genuine shortage behind a vaguer
 * label — see LiveOpsGapResolution/LiveOpsInvalidatedAssignment's own doc
 * comments in lib/live-ops-service.ts for exactly what each case means.
 */
function GapTriageDetail({ requirementView: r }: { requirementView: LiveOpsRequirementView }) {
  const [expanded, setExpanded] = useState(false);
  const hasGapInfo = Boolean(r.gapResolution);
  const hasInvalidated = r.invalidatedAssignments.length > 0;
  if (!hasGapInfo && !hasInvalidated) return null;

  return (
    <div className="flex flex-col gap-1 pl-1">
      <div className="flex items-center gap-2 flex-wrap">
        {hasInvalidated && (
          <button type="button" onClick={() => setExpanded((v) => !v)} className="text-left">
            <Badge tone="warn">Invalidated by flight change ({r.invalidatedAssignments.length})</Badge>
          </button>
        )}
        {r.gapResolution && (
          <button type="button" onClick={() => setExpanded((v) => !v)} className="text-left">
            <Badge tone={r.gapResolution.eligible ? "good" : "bad"}>
              {r.gapResolution.eligible ? "Resolvable — eligible employee available" : "No eligible employee"}
            </Badge>
          </button>
        )}
      </div>
      {expanded && (
        <div className="text-xs text-muted flex flex-col gap-1 pb-1">
          {r.invalidatedAssignments.map((inv) => (
            <p key={inv.employee.id}>
              <span className="font-medium text-ink">{inv.employee.name}</span>: planned window {inv.oldWindow.start}–
              {inv.oldWindow.end} is now {inv.newWindow.start}–{inv.newWindow.end}
              {inv.collidesWith && <> — collides with their {inv.collidesWith.flight.flight_number} duty</>}
              {inv.shiftBoundaryViolation && (
                <> — falls outside their shift ({inv.shiftBoundaryViolation.shiftStart}–{inv.shiftBoundaryViolation.shiftEnd})</>
              )}
            </p>
          ))}
          {r.gapResolution?.eligible === true && (
            <p>
              Eligible now: {r.gapResolution.candidates.filter((c) => c.status === "recommended").map((c) => c.employee.name).join(", ")}
            </p>
          )}
          {r.gapResolution?.eligible === false && (
            <>
              <p>No employee is currently eligible. Reasons:</p>
              <ul className="list-disc pl-4">
                {r.gapResolution.exclusionSummary.map((ex) => (
                  <li key={ex.reason}>
                    {ex.reason} ({ex.count})
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One assigned/proposed employee's chip, with an inline "Change" action
 * (2026-10-04) so reassigning a currently-covered requirement is always
 * one click away -- no disruption alert required first. `onReassign` is
 * only omitted when the parent board is rendered read-only; `canAct`
 * disables (but still shows) the action for a Viewer, matching Find
 * Agent's own treatment of the same boundary.
 */
export function EmployeeChip({
  name,
  tone,
  canAct,
  onReassign,
}: {
  name: string;
  tone: "assigned" | "proposed";
  canAct: boolean;
  onReassign?: () => void;
}) {
  const toneClass = tone === "assigned" ? "bg-gray-100 text-ink" : "bg-brand-50 text-brand-700";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${toneClass}`}>
      {name}
      {onReassign && (
        <button
          type="button"
          onClick={onReassign}
          disabled={!canAct}
          className="underline decoration-dotted underline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed hover:no-underline"
        >
          Change
        </button>
      )}
    </span>
  );
}
