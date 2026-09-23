import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { scoreCandidates, TimeWindow } from "@/lib/scoring";
import { CONFIG, CURRENT_WEEK_START } from "@/lib/seed-data";
import { planIdForWeek, fetchAllRosterEntriesForPlan } from "@/lib/planning/weekly-plan-service";
import { getRequirementWindow } from "@/lib/planning/requirement-window";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "@/lib/planning/duty-generation";
import { isFixedPlanningTeam, isTransitTeam } from "@/lib/teams";
import { Employee, Assignment, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry } from "@/lib/types";

function timeToMinutesLocal(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function windowsOverlapLocal(a: TimeWindow, b: TimeWindow): boolean {
  return timeToMinutesLocal(a.start) < timeToMinutesLocal(b.end) && timeToMinutesLocal(b.start) < timeToMinutesLocal(a.end);
}

/**
 * When scoreCandidates returns zero candidates, a bare "no candidates
 * found" leaves a Duty Officer with no idea WHY — per the product
 * owner's explicit ask (Part 4), this reconstructs an honest breakdown
 * of why each excluded employee was excluded, using the exact same
 * hard-exclusion predicates scoreCandidates itself applies (see
 * lib/scoring.ts's own doc comment on its non-negotiable exclusions).
 * This is reporting only — it never changes who is eligible, and never
 * offers a bypass for any of these constraints.
 */
function buildExclusionSummary(
  role: string,
  window: TimeWindow,
  allNotYetAssigned: Employee[],
  dayEffectivePool: Employee[],
  occupiedWindows: Record<string, TimeWindow[]>,
  requiredAuthorization?: string
): { reason: string; count: number }[] {
  const dayEffectiveIds = new Set(dayEffectivePool.map((e) => e.id));
  const counts = {
    inactive: 0,
    offOrNotRostered: 0,
    fixedOrTransitTeam: 0,
    overlappingCommitment: 0,
    noShiftOverlap: 0,
    notQualifiedOrAuthorized: 0,
  };

  for (const e of allNotYetAssigned) {
    if (!e.active) {
      counts.inactive++;
      continue;
    }
    if (!dayEffectiveIds.has(e.id)) {
      counts.offOrNotRostered++;
      continue;
    }
    const effective = dayEffectivePool.find((p) => p.id === e.id)!;
    if (e.is_duty_officer || isFixedPlanningTeam(e.assignment) || (isTransitTeam(e.assignment) && role !== "Transit")) {
      counts.fixedOrTransitTeam++;
      continue;
    }
    if ((occupiedWindows[e.id] ?? []).some((occupied) => windowsOverlapLocal(occupied, window))) {
      counts.overlappingCommitment++;
      continue;
    }
    if (!windowsOverlapLocal(window, { start: effective.shift_start!, end: effective.shift_end! })) {
      counts.noShiftOverlap++;
      continue;
    }
    const qualifies = requiredAuthorization
      ? effective.foreign_company_authorizations.includes(requiredAuthorization)
      : effective.skills.includes(role);
    if (!qualifies) counts.notQualifiedOrAuthorized++;
    // Anyone who clears every check above already appears in
    // scoreCandidates' own (recommended/flagged) output — this summary
    // only needs to explain the zero-candidate case.
  }

  const labels: Record<keyof typeof counts, string> = {
    inactive: "Inactive employee record",
    offOrNotRostered: "OFF or not rostered this day per the current plan",
    fixedOrTransitTeam: "On a fixed/specialized team or committed to Transit for the full shift",
    overlappingCommitment: "Already committed to an overlapping duty or protected company window",
    noShiftOverlap: "Shift does not overlap this requirement's time window at all",
    notQualifiedOrAuthorized: requiredAuthorization ? `Not authorized for ${requiredAuthorization}` : `Not qualified for ${role}`,
  };

  return (Object.keys(counts) as (keyof typeof counts)[])
    .filter((k) => counts[k] > 0)
    .map((k) => ({ reason: labels[k], count: counts[k] }));
}

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
  const rosterRows = plan ? await fetchAllRosterEntriesForPlan(supabase, plan.id) : ([] as WeeklyPlanRosterEntry[]);
  // The real calendar date this flight occurs on — resolves the correct
  // effective-dated shift regime (see lib/shift-templates.ts) for the
  // rostered shift boundaries below, rather than one global catalog.
  const candidatePool = buildDayEffectivePoolFromRosterEntries(
    notYetAssigned,
    rosterRows,
    targetFlight.day_of_week,
    targetFlight.flight_date
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

  // Only computed when there's nothing to show — cheap, and never changes
  // eligibility, only explains it (see buildExclusionSummary's own doc
  // comment; Part 4 of the product owner's guidance).
  const exclusionSummary =
    candidates.length === 0
      ? buildExclusionSummary(requirement.role, window, notYetAssigned, candidatePool, occupiedWindows, requiredAuthorization)
      : undefined;

  return NextResponse.json({ candidates, exclusionSummary });
}
