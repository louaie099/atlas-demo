import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates } from "@/lib/scoring";
import { CURRENT_WEEK_START } from "@/lib/seed-data";
import { planIdForWeek } from "@/lib/planning/weekly-plan-service";
import { getRequirementWindow } from "@/lib/planning/requirement-window";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "@/lib/planning/duty-generation";
import { Assignment, Employee, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry } from "@/lib/types";

const PLANNER_NAME = "Mohammed Alaoui";

export const dynamic = "force-dynamic";

/**
 * Manual assignment from Find Agent — this is a human planner filling a
 * real staffing gap, so it must be persisted as a genuine draft-plan
 * Assignment row (never client-side/local React state — see
 * components/find-agent-sheet.tsx, which calls this and then refetches
 * both /api/planning/weekly-view and this requirement's candidates so
 * Flight Coverage and Agent Schedule both reflect it immediately, and it
 * survives a refresh because it's a real row, read back on every GET).
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
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
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

  // A human modification only ever targets the current DRAFT plan --
  // editing a published plan's assignments isn't exposed anywhere in this
  // milestone (see lib/planning/weekly-plan-service.ts's publishPlan doc
  // comment); a future operational-modification layer is what that will
  // eventually go through.
  const { data: planRows } = await supabase.from("weekly_plans").select("*").eq("id", planIdForWeek(CURRENT_WEEK_START));
  const plan = (planRows as WeeklyPlan[] | null)?.[0];
  if (!plan) {
    return NextResponse.json({ error: "No draft plan exists for this week — generate one first." }, { status: 409 });
  }
  if (plan.status !== "draft") {
    return NextResponse.json(
      { error: "This week's plan has already been published — manual assignment against a published plan is not available yet." },
      { status: 409 }
    );
  }

  const { data: flight } = await supabase.from("flights").select("*").eq("id", requirement.flight_id).single();
  if (!flight) return NextResponse.json({ error: "Flight not found" }, { status: 404 });

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
  const dayEffectivePool = buildDayEffectivePoolFromRosterEntries(
    [employee as Employee],
    (rosterRows ?? []) as WeeklyPlanRosterEntry[],
    targetFlight.day_of_week,
    targetFlight.flight_date
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
