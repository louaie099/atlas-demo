import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates } from "@/lib/scoring";
import { weekStartFor, flightDateFor, DAYS_ORDER } from "@/lib/flight-date";
import { planIdForWeek } from "@/lib/planning/weekly-plan-service";
import { previousWeekStart } from "@/lib/planning/rotation-context";
import { getRequirementWindow } from "@/lib/planning/requirement-window";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "@/lib/planning/duty-generation";
import { ROLE_HEADER, getRoleFromHeader, canManageOperations } from "@/lib/roles";
import { Assignment, Employee, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry } from "@/lib/types";

const PLANNER_NAME = "Mohammed Alaoui";

export const dynamic = "force-dynamic";

/**
 * Manual assignment — fills a real, currently-uncovered staffing
 * requirement, whether from Monthly Planning's Find Agent or Live
 * Operations' own "Assign agent" action on a gap row (2026-10-04;
 * previously Find Agent-only). This must be persisted as a genuine
 * Assignment row (never client-side/local React state — see
 * components/find-agent-sheet.tsx, which calls this and then refetches
 * the caller's own view so Flight Coverage/Agent Schedule/Live Operations
 * all reflect it immediately, and it survives a refresh because it's a
 * real row, read back on every GET).
 *
 * Server-side re-validation (never trust the client that a candidate is
 * still valid): re-checks needs_configuration, remaining capacity, and
 * every eligibility rule (authorization/skill, availability, no
 * overlapping duty) using the exact same scoreCandidates/
 * computeBusyWindowsForDay pipeline Find Agent's own candidate list used
 * — so a stale candidate list, a race between two planners, or a client
 * bypassing the UI can never create an over-assigned or overlapping
 * duty. This is what makes the headcount and overlap invariants hold
 * even under concurrent/manual action, not just for automatic
 * generation.
 *
 * Role boundary (2026-10-04): only non-Viewer roles (Planner/
 * Administrator — see lib/roles.ts's canManageOperations doc comment on
 * why "Regulator"/"DO" collapse onto this same check in this demo's role
 * model) may call this. Checked server-side, not just hidden in the UI.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const role = getRoleFromHeader(req.headers.get(ROLE_HEADER));
  if (!canManageOperations(role)) {
    return NextResponse.json({ error: "Viewers cannot make assignments — Planner or Administrator role required." }, { status: 403 });
  }

  const { staffingRequirementId, employeeId } = await req.json();

  if (!staffingRequirementId || !employeeId) {
    return NextResponse.json({ error: "staffingRequirementId and employeeId are required" }, { status: 400 });
  }

  const [{ data: requirement }, { data: employee }] = await Promise.all([
    supabase.from("staffing_requirements").select("*").eq("id", staffingRequirementId).single(),
    supabase.from("employees").select("*").eq("id", employeeId).single(),
  ]);

  if (!requirement || !employee) {
    return NextResponse.json({ error: "Requirement or employee not found" }, { status: 404 });
  }

  if (requirement.needs_configuration) {
    return NextResponse.json(
      { error: "This requirement needs configuration before it can be staffed." },
      { status: 409 }
    );
  }

  const { data: flight } = await supabase.from("flights").select("*").eq("id", requirement.flight_id).single();
  if (!flight) return NextResponse.json({ error: "Flight not found" }, { status: 404 });

  // The plan looked up is always the one for the requirement's OWN
  // flight's week (never a fixed global week constant) — same week-
  // derivation fix lib/planning/candidate-lookup.ts already applies for
  // the candidate list this assignment is made from, so the two can never
  // disagree about which plan a given requirement belongs to.
  //
  // No plan.status gate here (2026-10-04 — previously blocked once a plan
  // was published): Live Operations' own gap-fill action needs to work
  // against the plan that's actually live, which is normally published,
  // not draft, and a manual reassignment of an already-covered slot
  // (app/api/confirm-reassignment/route.ts) was never gated on status in
  // the first place — this removes the inconsistency rather than
  // introducing a new behavior. Planning itself still only ever edits the
  // current plan row in place; nothing here mutates plan.status.
  const weekStart = weekStartFor((flight as Flight).flight_date);
  const { data: planRows } = await supabase.from("weekly_plans").select("*").eq("id", planIdForWeek(weekStart));
  const plan = (planRows as WeeklyPlan[] | null)?.[0];
  if (!plan) {
    return NextResponse.json({ error: "No plan exists for this requirement's week — generate one first." }, { status: 409 });
  }

  const [{ data: allAssignments }, { data: allRequirements }, { data: allFlights }] = await Promise.all([
    supabase.from("assignments").select("*"),
    supabase.from("staffing_requirements").select("*"),
    supabase.from("flights").select("*"),
  ]);

  const existingForRequirement = (allAssignments as Assignment[]).filter(
    (a) => a.staffing_requirement_id === staffingRequirementId
  );

  // Duplicate protection: this employee already holds this exact duty.
  if (existingForRequirement.some((a) => a.employee_id === employeeId)) {
    return NextResponse.json({ error: `${employee.name} is already assigned to this requirement.` }, { status: 409 });
  }

  // Headcount invariant, enforced server-side: reject once another
  // planner (or a stale client) has already filled the final slot —
  // never silently create assigned > required.
  if (existingForRequirement.length >= requirement.total_requirement) {
    return NextResponse.json(
      { error: `This requirement is already fully covered (${existingForRequirement.length}/${requirement.total_requirement}) — no remaining slots.` },
      { status: 409 }
    );
  }

  // Full eligibility re-check: authorization/skill, day-specific roster
  // status, and no overlapping duty already held that day — the exact
  // same rule Find Agent's own candidate list is built from, so the
  // Assign button can never bypass candidate validation.
  const targetFlight = flight as Flight;
  const window = getRequirementWindow(requirement as StaffingRequirement, targetFlight);

  // Day-effective gate, same as the Find Agent candidates API: this
  // employee is only a real candidate if THIS plan's persisted roster has
  // them working (not off) on this specific day. Without this, scoring
  // the raw employee row would only check that a shift profile exists at
  // all -- never whether it's a day they're actually off -- letting a
  // manual assignment silently override a fixed labor-rule protection
  // (e.g. max consecutive off days) that ATLAS's own generation is never
  // allowed to violate.
  const { data: rosterRows } = await supabase
    .from("weekly_plan_roster_entries")
    .select("*")
    .eq("plan_id", plan.id)
    .eq("employee_id", employeeId);

  // OVERNIGHT CARRYOVER (2026-10-06 activation) — same re-validation
  // Find Agent's own candidate list already applies (see
  // lib/planning/candidate-lookup.ts): an employee whose overnight shift
  // started the day before this flight can still be a genuine candidate,
  // even with no roster row of their own dated to this flight's day.
  const targetDayIndex = DAYS_ORDER.indexOf(targetFlight.day_of_week);
  const previousDayOfWeek = DAYS_ORDER[(targetDayIndex + DAYS_ORDER.length - 1) % DAYS_ORDER.length];
  const isWeekStart = targetDayIndex === 0;
  const previousDate = isWeekStart ? flightDateFor(previousWeekStart(weekStart), previousDayOfWeek) : flightDateFor(weekStart, previousDayOfWeek);
  const previousPlanId = isWeekStart ? planIdForWeek(previousWeekStart(weekStart)) : plan.id;
  const { data: previousRosterRows } = await supabase
    .from("weekly_plan_roster_entries")
    .select("*")
    .eq("plan_id", previousPlanId)
    .eq("employee_id", employeeId);

  const dayEffectivePool = buildDayEffectivePoolFromRosterEntries(
    [employee as Employee],
    (rosterRows ?? []) as WeeklyPlanRosterEntry[],
    targetFlight.day_of_week,
    targetFlight.flight_date,
    { dayOfWeek: previousDayOfWeek, date: previousDate, rosterEntries: (previousRosterRows ?? []) as WeeklyPlanRosterEntry[] }
  );

  if (dayEffectivePool.length === 0) {
    return NextResponse.json(
      { error: `${employee.name} is off on ${targetFlight.day_of_week} per this plan's roster — cannot be assigned a duty that day.` },
      { status: 409 }
    );
  }

  const occupiedWindows = computeBusyWindowsForDay(
    targetFlight.day_of_week,
    allAssignments as Assignment[],
    allRequirements as StaffingRequirement[],
    allFlights as Flight[],
    dayEffectivePool
  );
  const requiredAuthorization = requirement.source === "company_config" ? targetFlight.airline : undefined;
  // Scored against the plan's own frozen config_snapshot, not a possibly-
  // since-changed live CONFIG -- see lib/types.ts's WeeklyPlan doc comment.
  const [scored] = scoreCandidates(requirement.role, window, dayEffectivePool, plan.config_snapshot, occupiedWindows, requiredAuthorization);

  if (!scored) {
    return NextResponse.json(
      { error: `${employee.name} is no longer a valid candidate for this requirement — not rostered, not qualified/authorized, or already committed to an overlapping duty.` },
      { status: 409 }
    );
  }

  const assignmentId = `assign-${plan.id}-${staffingRequirementId}-${employeeId}`;
  const { error: insertErr } = await supabase.from("assignments").insert({
    id: assignmentId,
    plan_id: plan.id,
    staffing_requirement_id: staffingRequirementId,
    employee_id: employeeId,
    source: "human_modified",
    created_by: PLANNER_NAME,
  });
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  // Structured modification history -- a gap fill is action "added": there
  // is no previous_employee_id (nothing occupied this slot before), and
  // it's tagged to the plan's CURRENT revision so a later Regenerate can
  // unambiguously detect it (see regenerateDraftPlan's blocking check).
  const { error: modErr } = await supabase.from("assignment_modifications").insert({
    id: `mod-${assignmentId}`,
    plan_id: plan.id,
    plan_revision: plan.revision,
    staffing_requirement_id: staffingRequirementId,
    action: "added",
    previous_employee_id: null,
    new_employee_id: employeeId,
    changed_by: PLANNER_NAME,
    changed_at: new Date().toISOString(),
    reason: null,
  });
  if (modErr) return NextResponse.json({ error: modErr.message }, { status: 500 });

  const coverage = existingForRequirement.length + 1;

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
    description: `${employee.name} assigned to ${requirement.role} (${requirement.flight_id.toUpperCase()}) by ${PLANNER_NAME} — coverage ${coverage}/${requirement.total_requirement}`,
  });

  return NextResponse.json({ status: "assigned", coverage, total: requirement.total_requirement });
}
