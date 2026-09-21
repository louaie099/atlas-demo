import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates, TimeWindow } from "@/lib/scoring";
import { CURRENT_WEEK_START } from "@/lib/seed-data";
import { planIdForWeek } from "@/lib/planning/weekly-plan-service";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "@/lib/planning/duty-generation";
import { Assignment, Employee, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry, ZoneCheckinAssignment } from "@/lib/types";

const PLANNER_NAME = "Mohammed Alaoui";

export const dynamic = "force-dynamic";

/**
 * The zone-gap variant of /api/assign -- a human planner filling a real
 * T1 Check-in zone staffing gap. Same conceptual action as a per-flight
 * Find Agent assign ("a human modification against a draft plan"), just
 * against a checkin_zone_requirements id instead of a
 * staffing_requirement_id, and persisting into checkin_zone_assignments
 * with source "human_modified" instead of assignments. Follows the exact
 * same server-side re-validation / audit-log convention as /api/assign.
 */
export async function POST(req: Request) {
  const supabase = getSupabaseServerClient();
  const { zoneRequirementId, employeeId } = await req.json();

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

  const { data: existingForRequirement } = await supabase
    .from("checkin_zone_assignments")
    .select("*")
    .eq("zone_requirement_id", zoneRequirementId);
  const existing = (existingForRequirement ?? []) as ZoneCheckinAssignment[];

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
  const dayEffectivePool = buildDayEffectivePoolFromRosterEntries(
    [employee as Employee],
    (rosterRows ?? []) as WeeklyPlanRosterEntry[],
    requirement.day_of_week
  );
  if (dayEffectivePool.length === 0) {
    return NextResponse.json(
      { error: `${employee.name} is off on ${requirement.day_of_week} per this plan's roster — cannot be assigned a zone duty that day.` },
      { status: 409 }
    );
  }

  const [{ data: allAssignments }, { data: allRequirements }, { data: allFlights }] = await Promise.all([
    supabase.from("assignments").select("*"),
    supabase.from("staffing_requirements").select("*"),
    supabase.from("flights").select("*"),
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
  const { error: insertErr } = await supabase.from("checkin_zone_assignments").insert({
    id: assignmentId,
    plan_id: plan.id,
    zone_requirement_id: zoneRequirementId,
    employee_id: employeeId,
    window_start: requirement.window_start,
    window_end: requirement.window_end,
    source: "human_modified",
    created_by: PLANNER_NAME,
  });
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
    description: `${employee.name} assigned to ${requirement.zone} (${requirement.day_of_week} ${requirement.window_start}–${requirement.window_end}) by ${PLANNER_NAME} -- coverage ${coverage}/${requirement.required_headcount}`,
  });

  return NextResponse.json({ status: "assigned", coverage, total: requirement.required_headcount });
}
