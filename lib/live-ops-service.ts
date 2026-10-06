import { SupabaseClient } from "@supabase/supabase-js";

import { weekStartFor, DAYS_ORDER, dayOfWeekFor } from "./flight-date";
import { loadPersistedPlanView, planIdForWeek } from "./planning/weekly-plan-service";
import { getRequirementWindow } from "./planning/requirement-window";
import { getCandidatesForRequirement } from "./planning/candidate-lookup";
import { effectiveDeparture } from "./flight-operations";
import { TimeWindow, isWindowWithinShift } from "./scoring";
import {
  Assignment,
  AssignmentModification,
  CandidateResult,
  Employee,
  Flight,
  RosterRequirementView,
  StaffingRequirement,
  WeeklyPlan,
} from "./types";

const PLANNER_NAME = "Mohammed Alaoui";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return timeToMinutes(a.start) < timeToMinutes(b.end) && timeToMinutes(b.start) < timeToMinutes(a.end);
}

/**
 * ===========================================================================
 * Live Operations — plain, testable service functions behind the
 * app/api/live-ops*, app/api/flights/[id]/operational and (re-worked)
 * app/api/confirm-reassignment routes. Mirrors the separation
 * lib/planning/weekly-plan-service.ts already has from its own route
 * files: every function here takes a SupabaseClient (real or the fake
 * test harness) and returns plain data, no NextResponse.
 *
 * This is the real-data replacement for the old hardcoded "at201" +
 * lib/conflict.ts/planned_duties toy system (left in place, unused).
 * Every read here goes through loadPersistedPlanView — the SAME function
 * Monthly Planning uses — so Live Operations can never show a different
 * reality than Monthly Planning for the same week.
 * ===========================================================================
 */

// ---- 1. Read: what's happening operationally today -----------------------

// SCOPE SPLIT — read carefully before touching this interface or its two
// employee arrays:
//  - DISPLAY (assignedEmployees + proposedEmployees together) mirrors
//    Monthly Planning's own Flight Coverage card exactly: the bucket is
//    keyed off Assignment.source (human_modified vs atlas_generated — see
//    lib/planning/persisted-plan-view.ts), never off the plan's `status`.
//    An ATLAS-generated pick (proposedEmployees) is styled distinctly from
//    a human one (assignedEmployees), but both are already real,
//    persisted `assignments` rows the moment a plan is generated or
//    regenerated (see weekly-plan-service.ts's persistDraftPlanBundle) —
//    there is no separate "becomes real at publish" step any more
//    (2026-10-06, Draft/Publish removal; there never actually was one for
//    this table even before that — see persistDraftPlanBundle's own doc
//    comment).
//  - CONFLICT DETECTION / REASSIGNMENT (evaluateFlightDelayImpact,
//    confirmReassignment, below) is a DELIBERATELY separate boundary: it
//    only ever reads/writes real `assignments` table rows, same as
//    before. Because those rows already exist from generation time
//    onward, this flow has real data to work against for any plan, not
//    just one that happens to carry the "published" status value.
/**
 * Planned-vs-operational traceability for one requirement (2026-10-06,
 * Live Operations redesign section 12 — "preserve: Planned state versus
 * Operational state"). Populated whenever the LATEST assignment_modifications
 * row for this requirement, against the plan's CURRENT revision, replaced
 * one employee with another (action "replaced" — the only action
 * confirmReassignment ever writes). Undefined when a requirement's
 * current occupant has never been operationally changed — i.e. still
 * exactly what ATLAS/the planner last saved, nothing to trace.
 */
export interface LiveOpsRequirementModification {
  previousEmployeeName: string;
  newEmployeeName: string;
  changedAt: string;
  changedBy: string;
  reason: string | null;
}

export interface LiveOpsRequirementView {
  requirement: StaffingRequirement;
  coverageLabel: string;
  coverageStatus: RosterRequirementView["coverageStatus"];
  gap: number;
  assignedEmployees: Employee[];
  proposedEmployees: Employee[];
  modification?: LiveOpsRequirementModification;
}

export interface LiveOpsFlightView {
  flight: Flight;
  effectiveDeparture: string;
  requirements: LiveOpsRequirementView[];
}

/**
 * Compact workforce summary for the Live Operations header (section 2 of
 * the redesign spec) — derived from the SAME per-day AgentScheduleEntry
 * data Monthly Planning's Agent Schedule grid already renders (see
 * lib/types.ts's AgentDayEntry), never a separate workforce model.
 * `assignedToday` counts an employee as assigned when they hold at least
 * one real duty (flight OR T1 zone) that day; `availableToday` is simply
 * `workingToday - assignedToday`, so the three numbers are always
 * internally consistent by construction.
 */
export interface LiveOpsWorkforceSummary {
  workingToday: number;
  assignedToday: number;
  availableToday: number;
}

/**
 * Response shape for GET /api/live-ops?date=YYYY-MM-DD, documented here
 * since it's also exactly what this function returns:
 *
 *   { date: string, weekStart: string, plan: { id, status, revision } | null, flights: LiveOpsFlightView[] }
 *
 * `plan: null` means no plan exists yet for this date's week at all — the
 * frontend shows "no plan for this date" rather than an empty board.
 * `plan.status` is still carried through on the response (kept for
 * backward compatibility — see lib/types.ts's WeeklyPlan doc comment,
 * 2026-10-06), but this route never gates on it: whatever is currently
 * persisted for the week is shown, full stop — there is no separate
 * "published" milestone to wait for any more.
 */
export interface LiveOpsView {
  date: string;
  weekStart: string;
  plan: { id: string; status: WeeklyPlan["status"]; revision: number } | null;
  flights: LiveOpsFlightView[];
  workforce: LiveOpsWorkforceSummary;
}

export async function loadLiveOpsView(supabase: SupabaseClient, date: string): Promise<LiveOpsView> {
  const weekStart = weekStartFor(date);
  const view = await loadPersistedPlanView(supabase, weekStart, DAYS_ORDER);

  if (!view) {
    return { date, weekStart, plan: null, flights: [], workforce: { workingToday: 0, assignedToday: 0, availableToday: 0 } };
  }

  // Latest "replaced" modification per requirement, scoped to the plan's
  // CURRENT revision (a modification against a since-discarded revision
  // describes a different, no-longer-live roster and would mislead rather
  // than inform) — see LiveOpsRequirementModification's own doc comment.
  const { data: modRows } = await supabase
    .from("assignment_modifications")
    .select("*")
    .eq("plan_id", view.plan.id)
    .eq("plan_revision", view.plan.revision)
    .eq("action", "replaced");
  const modifications = (modRows ?? []) as AssignmentModification[];
  const employeesById = new Map(view.roster.flatMap((r) => [...r.assignedEmployees, ...r.proposedEmployees]).map((e) => [e.id, e]));
  // Any employee referenced only as a FORMER occupant (previous_employee_id)
  // may no longer appear in the current roster at all -- fall back to a
  // direct lookup so a replaced-away employee's name still shows correctly.
  const latestModByRequirement = new Map<string, AssignmentModification>();
  for (const m of modifications) {
    const existing = latestModByRequirement.get(m.staffing_requirement_id);
    if (!existing || m.changed_at > existing.changed_at) latestModByRequirement.set(m.staffing_requirement_id, m);
  }

  const dayFlights = view.flights.filter((f) => f.flight_date === date);

  const flights: LiveOpsFlightView[] = await Promise.all(
    dayFlights.map(async (flight) => {
      const requirements: LiveOpsRequirementView[] = await Promise.all(
        view.roster
          .filter((r) => r.flight.id === flight.id)
          .map(async (r) => {
            const mod = latestModByRequirement.get(r.requirement.id);
            let modification: LiveOpsRequirementModification | undefined;
            if (mod && mod.previous_employee_id && mod.new_employee_id) {
              let previousEmployee = employeesById.get(mod.previous_employee_id);
              if (!previousEmployee) {
                const { data: row } = await supabase.from("employees").select("*").eq("id", mod.previous_employee_id).single();
                previousEmployee = row as Employee | undefined;
              }
              const newEmployee = employeesById.get(mod.new_employee_id);
              modification = {
                previousEmployeeName: previousEmployee?.name ?? "Unknown",
                newEmployeeName: newEmployee?.name ?? "Unknown",
                changedAt: mod.changed_at,
                changedBy: mod.changed_by,
                reason: mod.reason,
              };
            }
            return {
              requirement: r.requirement,
              coverageLabel: r.coverageLabel,
              coverageStatus: r.coverageStatus,
              gap: r.gap,
              assignedEmployees: r.assignedEmployees,
              proposedEmployees: r.proposedEmployees,
              modification,
            };
          })
      );
      return { flight, effectiveDeparture: effectiveDeparture(flight), requirements };
    })
  );

  const dayOfWeek = dayOfWeekFor(date);
  let workingToday = 0;
  let assignedToday = 0;
  for (const entry of view.schedule) {
    const day = entry.days.find((d) => d.dayOfWeek === dayOfWeek);
    if (!day || day.status !== "working") continue;
    workingToday += 1;
    const hasDuty = day.duties.length > 0 || (day.zoneDuties ?? []).some((z) => z.status === "confirmed" || z.status === "assigned");
    if (hasDuty) assignedToday += 1;
  }
  const workforce: LiveOpsWorkforceSummary = {
    workingToday,
    assignedToday,
    availableToday: Math.max(0, workingToday - assignedToday),
  };

  return {
    date,
    weekStart,
    plan: { id: view.plan.id, status: view.plan.status, revision: view.plan.revision },
    flights,
    workforce,
  };
}

// ---- 2. Read-only impact analysis after a departure-time change ----------

export interface ConflictingAssignment {
  requirement: StaffingRequirement;
  flight: Flight;
  window: TimeWindow;
}

/**
 * A conflict can be caused by either or both of two independent reasons
 * (2026-10-04 fix — see this module's own history for the gap this
 * closes): the employee's new window now collides with another of their
 * own duties (`collidesWith`), and/or the new window no longer fits
 * inside the employee's own shift at all (`shiftBoundaryViolation`).
 * Previously ONLY the first was ever detected — an incumbent whose new
 * window simply ran past their shift end, with no OTHER duty to collide
 * with, was silently reported as still covered. Both fields are optional
 * and independent; at least one is always present on any conflict this
 * module reports.
 */
export interface ShiftBoundaryViolation {
  shiftStart: string;
  shiftEnd: string;
}

export interface LiveOpsImpactConflict {
  requirement: StaffingRequirement;
  oldWindow: TimeWindow;
  newWindow: TimeWindow;
  employee: Employee;
  collidesWith?: ConflictingAssignment;
  shiftBoundaryViolation?: ShiftBoundaryViolation;
  replacementCandidates: CandidateResult[];
  exclusionSummary?: { reason: string; count: number }[];
}

/**
 * Response shape for POST /api/live-ops/evaluate-impact { flightId }:
 *
 *   { flight: Flight, conflicts: LiveOpsImpactConflict[] }
 *
 * `conflicts` is empty when the flight's (possibly updated) departure
 * creates no real scheduling collision for anyone currently assigned to
 * one of its requirements. READ-ONLY — this never writes to the
 * database; the actual reassignment only happens via confirmReassignment
 * below, after a human confirms.
 */
export interface LiveOpsImpact {
  flight: Flight;
  conflicts: LiveOpsImpactConflict[];
}

export async function evaluateFlightDelayImpact(supabase: SupabaseClient, flightId: string): Promise<{ error: string; status: number } | LiveOpsImpact> {
  const { data: flightRow, error: flightErr } = await supabase.from("flights").select("*").eq("id", flightId).single();
  if (flightErr || !flightRow) return { error: "Flight not found", status: 404 };
  const flight = flightRow as Flight;

  const { data: requirementRows, error: reqErr } = await supabase
    .from("staffing_requirements")
    .select("*")
    .eq("flight_id", flightId);
  if (reqErr) return { error: reqErr.message, status: 500 };
  const requirements = (requirementRows ?? []) as StaffingRequirement[];

  const [{ data: allAssignments, error: assignErr }, { data: allRequirements, error: allReqErr }, { data: allFlights, error: allFlightErr }, { data: allEmployees, error: empErr }] =
    await Promise.all([
      supabase.from("assignments").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("flights").select("*"),
      supabase.from("employees").select("*"),
    ]);
  if (assignErr || allReqErr || allFlightErr || empErr) {
    return { error: (assignErr || allReqErr || allFlightErr || empErr)!.message, status: 500 };
  }

  const employeesById = new Map((allEmployees as Employee[]).map((e) => [e.id, e]));
  // Operational-delay fix (2026-10-04, sibling of the same fix in
  // lib/planning/candidate-lookup.ts): getRequirementWindow deliberately
  // never reads actual_departure -- every caller must substitute it in via
  // a shallow copy (see lib/flight-operations.ts's own doc comment). The
  // "this employee's other same-day commitments" loop below used the RAW
  // flight row for each OTHER duty, so if that OTHER duty's own flight had
  // ALSO been operationally delayed, its window was computed from its
  // stale scheduled time -- silently missing a real, newly-caused collision
  // whenever two of an employee's flights are disrupted together. Building
  // this map from effective-departure flights (a no-op for any flight with
  // no actual_departure set) fixes that without touching anything else in
  // this function; `effectiveFlight` below (built from the single
  // individually-fetched `flight` row) is kept as-is for this flight's own
  // requirement windows.
  const flightsById = new Map((allFlights as Flight[]).map((f) => [f.id, { ...f, scheduled_departure: effectiveDeparture(f) }]));
  // The TRUE "before any operational change" snapshot for the "was this
  // collision pre-existing" check below -- flight.scheduled_departure is
  // never mutated (see lib/types.ts), so the raw row IS the original
  // state, independent of flightsById's effective-departure substitution.
  const flightsRawById = new Map((allFlights as Flight[]).map((f) => [f.id, f]));
  const requirementsById = new Map((allRequirements as StaffingRequirement[]).map((r) => [r.id, r]));

  // getRequirementWindow fed an effective-departure copy of the flight —
  // unchanged, per the audit's own recommendation; scheduled_departure is
  // never mutated.
  const effectiveFlight: Flight = { ...flight, scheduled_departure: effectiveDeparture(flight) };

  const conflicts: LiveOpsImpactConflict[] = [];

  for (const requirement of requirements) {
    const requirementAssignments = (allAssignments as Assignment[]).filter((a) => a.staffing_requirement_id === requirement.id);
    if (requirementAssignments.length === 0) continue;

    const oldWindow = getRequirementWindow(requirement, flight);
    const newWindow = getRequirementWindow(requirement, effectiveFlight);

    for (const assignment of requirementAssignments) {
      const employee = employeesById.get(assignment.employee_id);
      if (!employee) continue;

      // This employee's OTHER same-day assignments. computeBusyWindowsForDay
      // (the exact pipeline duty-generation/Find Agent/Assign already
      // share) computes this same per-assignment window internally, but
      // only returns a flat TimeWindow[] — it doesn't carry back which
      // requirement/flight produced each window, which the structured
      // conflict report below needs (`collidesWith`). So this reuses its
      // SAME two building blocks directly — getRequirementWindow (the
      // identical window computation) and the same windowsOverlap
      // interval check every other overlap test in this codebase uses
      // (scoring.ts, candidate-lookup.ts) — rather than hand-rolling new
      // interval-overlap math. Scope note: like computeBusyWindowsForDay's
      // own second loop, this only covers ordinary flight-anchored duty
      // assignments, not a separate foreign-company protected-window
      // collision — acceptable here since the conflict this flow exists to
      // catch is exactly "assigned to two real duties that now overlap."
      //
      // Built TWICE (2026-10-04 fix) -- once from each OTHER flight's
      // effective (current, possibly also delayed) departure, and once
      // from its raw, never-mutated scheduled_departure -- because the
      // "was this pre-existing" check just below needs the TRUE before-
      // state of BOTH sides of a collision, not just this flight's own.
      // Previously the "other" side was computed once (from current data)
      // and compared against for both old and new, which silently missed
      // a real, newly-caused collision whenever the OTHER duty's flight
      // had ALSO been delayed into overlapping range: that duty's CURRENT
      // window looked identical whether checked against this flight's old
      // or new window, so a delay-caused collision could read as
      // "already overlapping" and be wrongly suppressed.
      const employeeId = employee.id;
      function otherCommitmentsAt(flightsMap: Map<string, Flight>): ConflictingAssignment[] {
        return (allAssignments as Assignment[])
          .filter((a) => a.employee_id === employeeId && a.staffing_requirement_id !== requirement.id)
          .map((a) => {
            const r = requirementsById.get(a.staffing_requirement_id);
            const f = r && flightsMap.get(r.flight_id);
            if (!r || !f || f.day_of_week !== flight.day_of_week) return null;
            return { requirement: r, flight: f, window: getRequirementWindow(r, f) };
          })
          .filter((c): c is ConflictingAssignment => c !== null);
      }
      const otherCommitmentsNew = otherCommitmentsAt(flightsById);
      const otherCommitmentsOld = otherCommitmentsAt(flightsRawById);

      const collidingRaw = otherCommitmentsNew.find((c) => windowsOverlap(newWindow, c.window));
      // Real collision only if this is a NEW one — if the two commitments
      // already overlapped before EITHER side's operational change, that's
      // a pre-existing state this flow isn't responsible for surfacing
      // (and ought to already have been caught at generation time), not
      // something caused by what changed just now.
      const priorOverlap =
        collidingRaw &&
        otherCommitmentsOld.find((c) => c.requirement.id === collidingRaw.requirement.id && windowsOverlap(oldWindow, c.window));
      const collidesWith = collidingRaw && !priorOverlap ? collidingRaw : undefined;

      // Shift-boundary check (2026-10-04 fix): does the NEW window still
      // fit inside this employee's own shift? Checked independently of
      // the collision above -- an employee can run past their shift end
      // with no other duty anywhere near it to "collide" with, and that
      // is still a real, reportable loss of validity, not coverage.
      // "New" in the same sense as the collision check: only reported
      // when the OLD window was still within shift (a pre-existing
      // out-of-shift assignment is a separate, already-existing data
      // problem, not something this delay just caused).
      const newlyOutOfShift =
        !isWindowWithinShift(newWindow, employee.shift_start, employee.shift_end) &&
        isWindowWithinShift(oldWindow, employee.shift_start, employee.shift_end);
      const shiftBoundaryViolation: ShiftBoundaryViolation | undefined =
        newlyOutOfShift && employee.shift_start && employee.shift_end
          ? { shiftStart: employee.shift_start, shiftEnd: employee.shift_end }
          : undefined;

      if (!collidesWith && !shiftBoundaryViolation) continue;

      const lookup = await getCandidatesForRequirement(supabase, requirement.id, {
        excludeEmployeeIds: [employee.id],
      });

      conflicts.push({
        requirement,
        oldWindow,
        newWindow,
        employee,
        collidesWith,
        shiftBoundaryViolation,
        replacementCandidates: lookup.ok ? lookup.candidates : [],
        exclusionSummary: lookup.ok ? lookup.exclusionSummary : undefined,
      });
    }
  }

  return { flight, conflicts };
}

// ---- 3. Write: confirm a reassignment -------------------------------------

export interface ConfirmReassignmentInput {
  staffingRequirementId: string;
  oldEmployeeId: string;
  newEmployeeId: string;
  reason: string;
}

export type ConfirmReassignmentResult =
  | { ok: false; status: number; error: string }
  | { ok: true; assignmentId: string };

/**
 * POST /api/confirm-reassignment body: ConfirmReassignmentInput, response:
 * ConfirmReassignmentResult (minus the `ok` discriminant on success:
 * `{ status: "confirmed", assignmentId }`).
 *
 * Mirrors app/api/assign/route.ts's exact persistence pattern for a new
 * Assignment row, plus:
 *  - removes the old Assignment row for (staffingRequirementId, oldEmployeeId)
 *    — a real delete, matching how this codebase already understands
 *    "replace an assignment" (regenerateDraftPlan deletes-and-reinserts a
 *    whole plan's assignments; here the same delete+insert semantics are
 *    applied to a single row) — never a mutation of the employee_id on
 *    the existing row, so a stale concurrent read never sees a row that
 *    silently changed identity.
 *  - inserts an assignment_modifications row with action "replaced" (the
 *    first real writer of that action — previously reserved/unused).
 *  - inserts a human-readable audit_log_entries row, via the same
 *    read-MAX-step_number-then-insert pattern every other writer uses.
 *
 * Never touches the original plan's roster or any OTHER assignment —
 * only the one requirement's row.
 */
export async function confirmReassignment(supabase: SupabaseClient, input: ConfirmReassignmentInput): Promise<ConfirmReassignmentResult> {
  const { staffingRequirementId, oldEmployeeId, newEmployeeId, reason } = input;

  const [{ data: requirement }, { data: oldEmployee }, { data: newEmployee }] = await Promise.all([
    supabase.from("staffing_requirements").select("*").eq("id", staffingRequirementId).single(),
    supabase.from("employees").select("*").eq("id", oldEmployeeId).single(),
    supabase.from("employees").select("*").eq("id", newEmployeeId).single(),
  ]);
  if (!requirement) return { ok: false, status: 404, error: "Staffing requirement not found" };
  if (!oldEmployee) return { ok: false, status: 404, error: "Current employee not found" };
  if (!newEmployee) return { ok: false, status: 404, error: "Replacement employee not found" };

  const { data: flight } = await supabase.from("flights").select("*").eq("id", (requirement as StaffingRequirement).flight_id).single();
  if (!flight) return { ok: false, status: 404, error: "Flight not found" };

  const weekStart = weekStartFor((flight as Flight).flight_date);
  const { data: planRows } = await supabase.from("weekly_plans").select("*").eq("id", planIdForWeek(weekStart));
  const plan = (planRows as WeeklyPlan[] | null)?.[0];
  if (!plan) return { ok: false, status: 409, error: "No plan exists for this requirement's week." };

  const { data: existingRows } = await supabase
    .from("assignments")
    .select("*")
    .eq("staffing_requirement_id", staffingRequirementId)
    .eq("employee_id", oldEmployeeId);
  const existing = (existingRows as Assignment[] | null)?.[0];
  if (!existing) {
    return { ok: false, status: 409, error: `${(oldEmployee as Employee).name} does not currently hold this assignment.` };
  }

  // Replace: delete the old row for this exact (requirement, employee)
  // pair, then insert a fresh row for the new employee — the same
  // delete+insert semantics this codebase already uses for "replace an
  // assignment" at plan-regeneration scale, applied to a single row.
  const { error: deleteErr } = await supabase.from("assignments").delete().eq("id", existing.id);
  if (deleteErr) return { ok: false, status: 500, error: deleteErr.message };

  const assignmentId = `assign-${plan.id}-${staffingRequirementId}-${newEmployeeId}`;
  const { error: insertErr } = await supabase.from("assignments").insert({
    id: assignmentId,
    plan_id: plan.id,
    staffing_requirement_id: staffingRequirementId,
    employee_id: newEmployeeId,
    source: "human_modified",
    created_by: PLANNER_NAME,
  });
  if (insertErr) return { ok: false, status: 500, error: insertErr.message };

  const { error: modErr } = await supabase.from("assignment_modifications").insert({
    id: `mod-${assignmentId}-${Date.now()}`,
    plan_id: plan.id,
    plan_revision: plan.revision,
    staffing_requirement_id: staffingRequirementId,
    action: "replaced",
    previous_employee_id: oldEmployeeId,
    new_employee_id: newEmployeeId,
    changed_by: PLANNER_NAME,
    changed_at: new Date().toISOString(),
    reason: reason ?? null,
  });
  if (modErr) return { ok: false, status: 500, error: modErr.message };

  const { data: lastStep } = await supabase
    .from("audit_log_entries")
    .select("step_number")
    .order("step_number", { ascending: false })
    .limit(1)
    .single();
  const nextStep = (lastStep?.step_number ?? 0) + 1;

  await supabase.from("audit_log_entries").insert({
    id: `audit-${nextStep}`,
    step_number: nextStep,
    description: `Operational reassignment: ${(flight as Flight).flight_number} ${(requirement as StaffingRequirement).role} moved from ${(oldEmployee as Employee).name} to ${(newEmployee as Employee).name} — ${reason}. Confirmed by ${PLANNER_NAME}.`,
  });

  return { ok: true, assignmentId };
}
