import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates, TimeWindow } from "@/lib/scoring";
import { CONFIG, CURRENT_WEEK_START } from "@/lib/seed-data";
import { planIdForWeek } from "@/lib/planning/weekly-plan-service";
import { getRequirementWindow } from "@/lib/planning/requirement-window";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "@/lib/planning/duty-generation";
import { Employee, Assignment, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { requirementId: string } }
) {
  const supabase = getSupabaseServerClient();

  const { data: requirement, error: reqErr } = await supabase
    .from("staffing_requirements")
    .select("*")
    .eq("id", params.requirementId)
    .single();

  if (reqErr || !requirement) {
    return NextResponse.json({ error: "Staffing requirement not found" }, { status: 404 });
  }

  if (requirement.needs_configuration) {
    return NextResponse.json(
      { error: "This requirement needs configuration before candidates can be evaluated." },
      { status: 409 }
    );
  }

  const { data: flight, error: flightErr } = await supabase
    .from("flights")
    .select("*")
    .eq("id", requirement.flight_id)
    .single();
  if (flightErr || !flight) return NextResponse.json({ error: "Flight not found" }, { status: 404 });

  const { data: employees, error: empErr } = await supabase.from("employees").select("*");
  if (empErr) return NextResponse.json({ error: empErr.message }, { status: 500 });

  // Score against the CURRENT draft plan's own frozen config_snapshot
  // (lib/types.ts's WeeklyPlan doc comment) -- never a later live CONFIG
  // change silently reinterpreting which candidates look eligible for a
  // plan already generated under different resolved rules. Falls back to
  // the live CONFIG only if somehow no plan exists yet (defensive; Find
  // Agent has nothing to fill without a generated plan in the first place).
  const { data: planRows } = await supabase.from("weekly_plans").select("*").eq("id", planIdForWeek(CURRENT_WEEK_START));
  const plan = (planRows as WeeklyPlan[] | null)?.[0];
  const effectiveConfig = plan?.config_snapshot ?? CONFIG;

  // Fetch ALL assignments/requirements/flights, not just this requirement's
  // — computing an employee's protected commitments for this date requires
  // seeing every assignment they hold across the whole schedule, not only
  // the one being evaluated right now.
  const [{ data: allAssignments, error: assignErr }, { data: allRequirements, error: allReqErr }, { data: allFlights, error: allFlightErr }] =
    await Promise.all([
      supabase.from("assignments").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("flights").select("*"),
    ]);
  if (assignErr || allReqErr || allFlightErr) {
    return NextResponse.json({ error: (assignErr || allReqErr || allFlightErr)?.message }, { status: 500 });
  }

  const requirementAssignments = (allAssignments as Assignment[]).filter(
    (a) => a.staffing_requirement_id === requirement.id
  );
  const alreadyAssignedIds = new Set(requirementAssignments.map((a) => a.employee_id));
  const notYetAssigned = (employees as Employee[]).filter((e) => !alreadyAssignedIds.has(e.id));

  const targetFlight = flight as Flight;

  // Day-effective gate: only employees actually working THIS plan's
  // persisted roster on this specific day are real candidates -- someone
  // whose roster entry says "off" (or who has no entry at all, e.g. no
  // plan exists yet) is excluded here rather than left for
  // scoreCandidates, which only checks that a shift profile exists at
  // all, never day-specific status. See buildDayEffectivePoolFromRosterEntries's
  // doc comment for why this matters (a fixed labor-rule protection like
  // max consecutive off days must never be overridable via manual
  // assignment either).
  const { data: rosterRows } = plan
    ? await supabase.from("weekly_plan_roster_entries").select("*").eq("plan_id", plan.id)
    : { data: [] as WeeklyPlanRosterEntry[] };
  const candidatePool = buildDayEffectivePoolFromRosterEntries(
    notYetAssigned,
    (rosterRows ?? []) as WeeklyPlanRosterEntry[],
    targetFlight.day_of_week
  );

  const window: TimeWindow = getRequirementWindow(requirement, targetFlight);

  // Every window this specific date's already-persisted Assignments make
  // an employee unavailable for — foreign commitments AND every other RAM/
  // company_config duty (Gate, Boarding, Profiling, Mesure alike). Shared
  // with duty-generation.ts and the Assign API's own re-validation so all
  // three can never disagree about who's actually free (this is the fix
  // for "Find Agent recommends someone already on an overlapping duty",
  // e.g. Sara Bennis appearing eligible for both Gate and Boarding).
  const occupiedWindows = computeBusyWindowsForDay(
    targetFlight.day_of_week,
    allAssignments as Assignment[],
    allRequirements as StaffingRequirement[],
    allFlights as Flight[],
    candidatePool
  );

  // Same rule duty-generation.ts uses: a company_config requirement is
  // filled by real company authorization, not a flight-task skill.
  const requiredAuthorization = requirement.source === "company_config" ? targetFlight.airline : undefined;
  const candidates = scoreCandidates(requirement.role, window, candidatePool, effectiveConfig, occupiedWindows, requiredAuthorization);

  return NextResponse.json({ candidates });
}
