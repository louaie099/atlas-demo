import { SupabaseClient } from "@supabase/supabase-js";

import { weekStartFor, DAYS_ORDER } from "./flight-date";
import { loadPersistedPlanView, planIdForWeek } from "./planning/weekly-plan-service";
import { getRequirementWindow } from "./planning/requirement-window";
import { getCandidatesForRequirement } from "./planning/candidate-lookup";
import { effectiveDeparture } from "./flight-operations";
import { TimeWindow } from "./scoring";
import {
  Assignment,
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
//  - DISPLAY (assignedEmployees + proposedEmployees together) now mirrors
//    Monthly Planning's own Flight Coverage card exactly: a still-draft
//    plan's engine-only picks (proposedEmployees) are shown alongside any
//    real Assignment rows (assignedEmployees), styled distinctly, so Live
//    Operations never falsely shows "— gap —" for coverage that genuinely
//    exists in the draft plan. See the "This date's plan is still a
//    draft" banner in app/operations/page.tsx — this is the same
//    explicitly-supported non-error state.
//  - CONFLICT DETECTION / REASSIGNMENT (evaluateFlightDelayImpact,
//    confirmReassignment, below) is a DELIBERATELY separate boundary: it
//    only ever reads/writes real `assignments` table rows, same as
//    before. A still-draft day now HONESTLY shows who ATLAS has
//    tentatively planned, but the delay/conflict/reassignment flow may
//    find nothing to flag until the plan is published and those picks
//    become real Assignment rows. Do not change that behavior here.
export interface LiveOpsRequirementView {
  requirement: StaffingRequirement;
  coverageLabel: string;
  coverageStatus: RosterRequirementView["coverageStatus"];
  gap: number;
  assignedEmployees: Employee[];
  proposedEmployees: Employee[];
}

export interface LiveOpsFlightView {
  flight: Flight;
  effectiveDeparture: string;
  requirements: LiveOpsRequirementView[];
}

/**
 * Response shape for GET /api/live-ops?date=YYYY-MM-DD, documented here
 * since it's also exactly what this function returns:
 *
 *   { date: string, weekStart: string, plan: { id, status, revision } | null, flights: LiveOpsFlightView[] }
 *
 * `plan: null` means no plan (draft or published) exists yet for this
 * date's week at all — the frontend should show "no plan for this date"
 * rather than an empty board. When `plan` is non-null but
 * `plan.status !== "published"`, `flights` is still populated (this route
 * does NOT hard-gate on published — see the module/route doc comment) so
 * the frontend can distinguish "no plan at all" from "a draft plan exists
 * but nothing has been published yet" and choose how to present each.
 */
export interface LiveOpsView {
  date: string;
  weekStart: string;
  plan: { id: string; status: WeeklyPlan["status"]; revision: number } | null;
  flights: LiveOpsFlightView[];
}

export async function loadLiveOpsView(supabase: SupabaseClient, date: string): Promise<LiveOpsView> {
  const weekStart = weekStartFor(date);
  const view = await loadPersistedPlanView(supabase, weekStart, DAYS_ORDER);

  if (!view) {
    return { date, weekStart, plan: null, flights: [] };
  }

  const dayFlights = view.flights.filter((f) => f.flight_date === date);

  const flights: LiveOpsFlightView[] = dayFlights.map((flight) => {
    const requirements: LiveOpsRequirementView[] = view.roster
      .filter((r) => r.flight.id === flight.id)
      .map((r) => ({
        requirement: r.requirement,
        coverageLabel: r.coverageLabel,
        coverageStatus: r.coverageStatus,
        gap: r.gap,
        assignedEmployees: r.assignedEmployees,
        proposedEmployees: r.proposedEmployees,
      }));
    return { flight, effectiveDeparture: effectiveDeparture(flight), requirements };
  });

  return {
    date,
    weekStart,
    plan: { id: view.plan.id, status: view.plan.status, revision: view.plan.revision },
    flights,
  };
}

// ---- 2. Read-only impact analysis after a departure-time change ----------

export interface ConflictingAssignment {
  requirement: StaffingRequirement;
  flight: Flight;
  window: TimeWindow;
}

export interface LiveOpsImpactConflict {
  requirement: StaffingRequirement;
  oldWindow: TimeWindow;
  newWindow: TimeWindow;
  employee: Employee;
  collidesWith: ConflictingAssignment;
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
  const flightsById = new Map((allFlights as Flight[]).map((f) => [f.id, f]));
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
      const otherCommitments = (allAssignments as Assignment[])
        .filter((a) => a.employee_id === employee.id && a.staffing_requirement_id !== requirement.id)
        .map((a) => {
          const r = requirementsById.get(a.staffing_requirement_id);
          const f = r && flightsById.get(r.flight_id);
          if (!r || !f || f.day_of_week !== flight.day_of_week) return null;
          return { requirement: r, flight: f, window: getRequirementWindow(r, f) };
        })
        .filter((c): c is ConflictingAssignment => c !== null);

      const colliding = otherCommitments.find((c) => windowsOverlap(newWindow, c.window));
      if (!colliding) continue;

      // Real conflict only if this is a NEW collision — if the two
      // commitments already overlapped before the operational change,
      // that's a pre-existing state this flow isn't responsible for
      // surfacing (and ought to already have been caught at generation
      // time), not something this delay just caused.
      if (windowsOverlap(oldWindow, colliding.window)) continue;

      const lookup = await getCandidatesForRequirement(supabase, requirement.id, {
        excludeEmployeeIds: [employee.id],
      });

      conflicts.push({
        requirement,
        oldWindow,
        newWindow,
        employee,
        collidesWith: colliding,
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
