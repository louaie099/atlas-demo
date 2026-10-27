import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates, TimeWindow } from "@/lib/scoring";
import { fetchAllAssignmentsForPlan, fetchAllRequirementsForFlightIds } from "@/lib/planning/weekly-plan-service";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "@/lib/planning/duty-generation";
import { flightDateFor } from "@/lib/flight-date";
import { canManageOperations } from "@/lib/roles";
import { resolveRole, resolveActorName } from "@/lib/resolve-role";
import { CHECKIN_ZONES, CheckinZoneId } from "@/lib/checkin-zones";
import { Assignment, Employee, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry, ZoneCheckinAssignment } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The zone-gap variant of /api/assign -- a human planner filling a real
 * T1 Check-in zone staffing gap. Same conceptual action as a per-flight
 * Find Agent assign ("a human modification against the current plan"),
 * just against a checkin_zone_requirements id instead of a
 * staffing_requirement_id, and persisting into checkin_zone_assignments
 * with source "human_modified" instead of assignments. Follows the exact
 * same server-side re-validation / audit-log convention as /api/assign.
 *
 * No plan.status gate (2026-10-06, Draft/Publish removal -- this route
 * previously blocked once a plan's status wasn't "draft", unlike
 * /api/assign's own equivalent gate which had already been removed
 * 2026-10-04; that inconsistency is now closed the same way): Monthly
 * Planning is the one always-editable workspace, so manual zone assignment
 * must work against whatever the current plan is, status notwithstanding.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const role = await resolveRole(req);
  if (!canManageOperations(role)) {
    return NextResponse.json({ error: "Viewers cannot make assignments — Planner, Regulator or Administrator role required." }, { status: 403 });
  }
  const PLANNER_NAME = await resolveActorName();
  const { zoneRequirementId, employeeId, counter } = await req.json();

  if (!zoneRequirementId || !employeeId) {
    return NextResponse.json({ error: "zoneRequirementId and employeeId are required" }, { status: 400 });
  }

  const [{ data: requirement }, { data: employee }] = await Promise.all([
    supabase.from("checkin_zone_requirements").select("*").eq("id", zoneRequirementId).single(),
    supabase.from("employees").select("*").eq("id", employeeId).single(),
  ]);
  if (!requirement || !employee) {
    return NextResponse.json({ error: "Zone requirement or employee not found" }, { status: 404 });
  }

  const { data: planRows } = await supabase.from("weekly_plans").select("*").eq("id", requirement.plan_id);
  const plan = (planRows as WeeklyPlan[] | null)?.[0];
  if (!plan) {
    return NextResponse.json({ error: "No plan exists for this week — generate one first." }, { status: 409 });
  }

  const { data: existingForRequirement } = await supabase
    .from("checkin_zone_assignments")
    .select("*")
    .eq("zone_requirement_id", zoneRequirementId);
  const existing = (existingForRequirement ?? []) as ZoneCheckinAssignment[];

  let counterNumber: number | null = null;
  if (counter !== undefined && counter !== null) {
    const range = CHECKIN_ZONES[requirement.zone as CheckinZoneId]?.counters;
    counterNumber = Number(counter);
    if (!Number.isInteger(counterNumber) || !range || counterNumber < range.from || counterNumber > range.to) {
      return NextResponse.json({ error: `Counter ${counter} is not a counter of this zone.` }, { status: 400 });
    }
    const holder = existing.find((a) => a.counter === counterNumber);
    if (holder) {
      return NextResponse.json({ error: `Counter ${counterNumber} already has an agent assigned for this window — release them first.` }, { status: 409 });
    }
  }

  if (existing.some((a) => a.employee_id === employeeId)) {
    return NextResponse.json({ error: `${employee.name} is already assigned to this zone requirement.` }, { status: 409 });
  }

  if (existing.length >= requirement.required_headcount) {
    return NextResponse.json(
      {
        error: `This zone requirement is already fully covered (${existing.length}/${requirement.required_headcount}) -- no remaining slots.`,
      },
      { status: 409 }
    );
  }

  const { data: rosterRows } = await supabase
    .from("weekly_plan_roster_entries")
    .select("*")
    .eq("plan_id", plan.id)
    .eq("employee_id", employeeId);
  const requirementDate = flightDateFor(plan.week_start, requirement.day_of_week);
  const dayEffectivePool = buildDayEffectivePoolFromRosterEntries(
    [employee as Employee],
    (rosterRows ?? []) as WeeklyPlanRosterEntry[],
    requirement.day_of_week,
    requirementDate
  );
  if (dayEffectivePool.length === 0) {
    return NextResponse.json(
      { error: `${employee.name} is off on ${requirement.day_of_week} per this plan's roster — cannot be assigned a zone duty that day.` },
      { status: 409 }
    );
  }

  // 2026-10-09 (pagination/cross-week-leakage audit — see
  // app/api/assign/route.ts's own doc comment for the full incident):
  // scoped to this plan's own week instead of a bare, unscoped,
  // unpaginated `.select("*")`.
  const { data: weekFlightsRaw } = await supabase.from("flights").select("*").eq("week_start", plan.week_start);
  const allFlights = (weekFlightsRaw ?? []) as Flight[];
  const weekFlightIds = allFlights.map((f) => f.id);
  const [allAssignments, allRequirements] = await Promise.all([
    fetchAllAssignmentsForPlan(supabase, plan.id),
    fetchAllRequirementsForFlightIds(supabase, weekFlightIds),
  ]);

  const window: TimeWindow = { start: requirement.window_start, end: requirement.window_end };
  const occupiedWindows = computeBusyWindowsForDay(
    requirement.day_of_week,
    (allAssignments ?? []) as Assignment[],
    (allRequirements ?? []) as StaffingRequirement[],
    (allFlights ?? []) as Flight[],
    dayEffectivePool
  );
  const [scored] = scoreCandidates("Check-in", window, dayEffectivePool, plan.config_snapshot, occupiedWindows);
  if (!scored) {
    return NextResponse.json(
      {
        error: `${employee.name} is no longer a valid candidate for this zone requirement -- not rostered, not Check-in-qualified, or already committed to an overlapping duty.`,
      },
      { status: 409 }
    );
  }

  const assignmentId = `zoneassign-${plan.id}-${zoneRequirementId}-${employeeId}-human`;
  const baseRow: Record<string, unknown> = {
    id: assignmentId,
    plan_id: plan.id,
    zone_requirement_id: zoneRequirementId,
    employee_id: employeeId,
    window_start: requirement.window_start,
    window_end: requirement.window_end,
    source: "human_modified",
    created_by: PLANNER_NAME,
  };
  let counterSaved = counterNumber !== null;
  let { error: insertErr } = await supabase.from("checkin_zone_assignments").insert(counterNumber !== null ? { ...baseRow, counter: counterNumber } : baseRow);
  if (insertErr && counterNumber !== null && /counter/i.test(insertErr.message)) {
    // Migration 0019 (counter column) not applied yet: still make the zone assignment, say the counter was not stored.
    counterSaved = false;
    ({ error: insertErr } = await supabase.from("checkin_zone_assignments").insert(baseRow));
  }
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  const coverage = existing.length + 1;

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
    description: `${employee.name} assigned to ${requirement.zone} (${requirement.day_of_week} ${requirement.window_start}–${requirement.window_end})${counterSaved ? ` counter ${counterNumber}` : ""} by ${PLANNER_NAME} -- coverage ${coverage}/${requirement.required_headcount}`,
  });

  return NextResponse.json({ status: "assigned", coverage, total: requirement.required_headcount, counter: counterSaved ? counterNumber : null, counterWarning: counterNumber !== null && !counterSaved ? "Assigned to the zone, but the counter number was not saved — apply migration 0019 (counter column)." : undefined });
}

/**
 * Release (un-assign) a HUMAN-made zone assignment -- the Live Operations
 * counterpart of POST above, so a regulator can undo or correct a T1 zone
 * placement without touching the plan's own generated coverage. Only
 * `human_modified` rows can be released: engine-derived coverage is not a
 * persisted assignment (see checkin-capacity-timeline.ts) and is changed by
 * re-planning, not here. Same role boundary and audit convention as POST.
 */
export async function DELETE(req: Request) {
  const supabase = getSupabaseServerClient();
  const role = await resolveRole(req);
  if (!canManageOperations(role)) {
    return NextResponse.json({ error: "Viewers cannot change assignments — Planner, Regulator or Administrator role required." }, { status: 403 });
  }
  const PLANNER_NAME = await resolveActorName();
  const { zoneRequirementId, employeeId } = await req.json();
  if (!zoneRequirementId || !employeeId) {
    return NextResponse.json({ error: "zoneRequirementId and employeeId are required" }, { status: 400 });
  }

  const [{ data: requirement }, { data: employee }, { data: rows }] = await Promise.all([
    supabase.from("checkin_zone_requirements").select("*").eq("id", zoneRequirementId).single(),
    supabase.from("employees").select("*").eq("id", employeeId).single(),
    supabase.from("checkin_zone_assignments").select("*").eq("zone_requirement_id", zoneRequirementId).eq("employee_id", employeeId),
  ]);
  const assignment = ((rows ?? []) as ZoneCheckinAssignment[])[0];
  if (!requirement || !employee || !assignment) {
    return NextResponse.json({ error: "That zone assignment does not exist." }, { status: 404 });
  }
  if (assignment.source !== "human_modified") {
    return NextResponse.json({ error: "Only manually added zone assignments can be released here." }, { status: 409 });
  }

  const { error: delErr } = await supabase.from("checkin_zone_assignments").delete().eq("id", assignment.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  const { data: lastStep } = await supabase.from("audit_log_entries").select("step_number").order("step_number", { ascending: false }).limit(1).single();
  const nextStep = (lastStep?.step_number ?? 0) + 1;
  await supabase.from("audit_log_entries").insert({
    id: `audit-${nextStep}`,
    step_number: nextStep,
    description: `${employee.name} released from ${requirement.zone} (${requirement.day_of_week} ${requirement.window_start}–${requirement.window_end}) by ${PLANNER_NAME}`,
  });
  return NextResponse.json({ status: "released" });
}
