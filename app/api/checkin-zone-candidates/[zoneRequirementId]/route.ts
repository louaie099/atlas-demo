import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates, TimeWindow } from "@/lib/scoring";
import { CURRENT_WEEK_START } from "@/lib/seed-data";
import { planIdForWeek, fetchAllRosterEntriesForPlan } from "@/lib/planning/weekly-plan-service";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "@/lib/planning/duty-generation";
import { flightDateFor } from "@/lib/flight-date";
import { Employee, Assignment, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry, ZoneCheckinAssignment } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The zone-gap variant of /api/candidates/[requirementId] -- Find Agent
 * against a checkin_zone_requirements row instead of a
 * staffing_requirements row. Deliberately a SEPARATE route rather than
 * overloading the existing one: a zone requirement has no `flight_id`, no
 * `role` other than the fixed "Check-in" (per the prototype eligibility
 * rule -- see lib/checkin-zones.ts's module doc comment: any Check-in-
 * qualified ACE is eligible for any ordinary zone today, no zone-specific
 * qualification modeled yet), and its window comes from the requirement
 * row itself rather than from a flight+aircraft rule. Reuses
 * scoreCandidates/computeBusyWindowsForDay/buildDayEffectivePoolFromRosterEntries
 * exactly as the flight-requirement route does -- no parallel eligibility
 * engine.
 */
export async function GET(_req: Request, { params }: { params: { zoneRequirementId: string } }) {
  const supabase = getSupabaseServerClient();

  const { data: requirement, error: reqErr } = await supabase
    .from("checkin_zone_requirements")
    .select("*")
    .eq("id", params.zoneRequirementId)
    .single();
  if (reqErr || !requirement) {
    return NextResponse.json({ error: "Zone requirement not found" }, { status: 404 });
  }

  const { data: employees, error: empErr } = await supabase.from("employees").select("*");
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 });

  const { data: planRows } = await supabase.from("weekly_plans").select("*").eq("id", planIdForWeek(CURRENT_WEEK_START));
  const plan = (planRows as WeeklyPlan[] | null)?.[0];
  const effectiveConfig = plan?.config_snapshot;
  if (!effectiveConfig) {
    return NextResponse.json({ error: "No draft plan exists for this week — generate one first." }, { status: 409 });
  }

  const [
    { data: allAssignments, error: assignErr },
    { data: allRequirements, error: allReqErr },
    { data: allFlights, error: allFlightErr },
    { data: existingZoneAssignments, error: zoneAssignErr },
  ] = await Promise.all([
    supabase.from("assignments").select("*"),
    supabase.from("staffing_requirements").select("*"),
    supabase.from("flights").select("*"),
    supabase.from("checkin_zone_assignments").select("*").eq("zone_requirement_id", params.zoneRequirementId),
  ]);
  if (assignErr || allReqErr || allFlightErr || zoneAssignErr) {
    return NextResponse.json({ error: (assignErr || allReqErr || allFlightErr || zoneAssignErr)?.message }, { status: 500 });
  }

  const alreadyAssignedIds = new Set(((existingZoneAssignments ?? []) as ZoneCheckinAssignment[]).map((a) => a.employee_id));
  const notYetAssigned = (employees as Employee[]).filter((e) => !alreadyAssignedIds.has(e.id));

  const rosterRows = plan ? await fetchAllRosterEntriesForPlan(supabase, plan.id) : ([] as WeeklyPlanRosterEntry[]);
  // The real calendar date this zone requirement's day_of_week refers to
  // within THIS plan's own week — resolves the correct effective-dated
  // shift regime (see lib/shift-templates.ts). `plan` is guaranteed
  // non-null here (the effectiveConfig check above already returned 409
  // otherwise).
  const requirementDate = flightDateFor(plan!.week_start, requirement.day_of_week);
  const candidatePool = buildDayEffectivePoolFromRosterEntries(notYetAssigned, rosterRows, requirement.day_of_week, requirementDate);

  const window: TimeWindow = { start: requirement.window_start, end: requirement.window_end };

  // Every window this date's already-persisted flight-anchored Assignments
  // (Gate/Boarding/Profiling/Mesure/foreign-company -- unchanged) make an
  // employee unavailable for -- the SAME shared function the flight-
  // requirement route and duty-generation.ts use, so a zone Find Agent can
  // never recommend someone already committed to an overlapping per-flight
  // duty. Existing zone assignments elsewhere in the day are intentionally
  // NOT added here beyond the pool exclusion above -- default zone
  // placement is deliberately allowed to be non-exclusive time (an
  // employee already covering one zone window is still excluded from a
  // SECOND, overlapping one only through this same overlap check once
  // their zone commitment is itself represented as an occupied window in
  // a future iteration; today's zone assignments do not yet feed back into
  // this occupiedWindows map, matching the "prototype, extensible" status
  // called out in checkin-zones.ts).
  const occupiedWindows = computeBusyWindowsForDay(
    requirement.day_of_week,
    allAssignments as Assignment[],
    allRequirements as StaffingRequirement[],
    allFlights as Flight[],
    candidatePool
  );

  const candidates = scoreCandidates("Check-in", window, candidatePool, effectiveConfig, occupiedWindows);

  return NextResponse.json({ candidates });
}
