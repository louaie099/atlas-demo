import { SupabaseClient } from "@supabase/supabase-js";

import { scoreCandidates, TimeWindow } from "../scoring";
import { planIdForWeek, fetchAllRosterEntriesForPlan } from "./weekly-plan-service";
import { previousWeekStart } from "./rotation-context";
import { getRequirementWindow } from "./requirement-window";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "./duty-generation";
import { isFixedPlanningTeam, isTransitTeam } from "../teams";
import { weekStartFor, flightDateFor, DAYS_ORDER } from "../flight-date";
import { effectiveDeparture } from "../flight-operations";
import { buildFatigueStatesEnteringDate } from "./fatigue-live-lookup";
import { CandidateFatigueInput } from "./fatigue-planning";
import { Employee, Assignment, Flight, StaffingRequirement, WeeklyPlan, WeeklyPlanRosterEntry, CandidateResult } from "../types";

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

export type CandidateLookupResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      candidates: CandidateResult[];
      exclusionSummary?: { reason: string; count: number }[];
      requirement: StaffingRequirement;
      flight: Flight;
      plan: WeeklyPlan;
    };

/**
 * The shared, plain (no NextResponse) core of "who can cover this
 * requirement" — used by GET /api/candidates/[requirementId] (Find
 * Agent) AND by the Live Operations impact-evaluation flow
 * (lib/live-ops-service.ts), which needs the exact same eligibility
 * pipeline to find a REPLACEMENT for a now-conflicted employee. Extracted
 * here, rather than the route handler literally HTTP-fetching its own
 * API, so both callers share one implementation and can never disagree
 * about who's eligible.
 *
 * Week derivation bug fix (2026-10-03): this used to hardcode
 * `CURRENT_WEEK_START` — wrong for any requirement whose flight falls
 * outside that one fixed demo week. The plan looked up is now always the
 * one for the requirement's OWN flight's week (`weekStartFor(flight.flight_date)`),
 * never a global constant. No `plan.status` gate is applied (matches the
 * route's pre-existing behavior) — this works against a draft or a
 * published plan alike.
 */
export async function getCandidatesForRequirement(
  supabase: SupabaseClient,
  requirementId: string,
  options?: { excludeEmployeeIds?: string[] }
): Promise<CandidateLookupResult> {
  const { data: requirement, error: reqErr } = await supabase
    .from("staffing_requirements")
    .select("*")
    .eq("id", requirementId)
    .single();

  if (reqErr || !requirement) {
    return { ok: false, status: 404, error: "Staffing requirement not found" };
  }

  if (requirement.needs_configuration) {
    return { ok: false, status: 409, error: "This requirement needs configuration before candidates can be evaluated." };
  }

  const { data: flight, error: flightErr } = await supabase
    .from("flights")
    .select("*")
    .eq("id", requirement.flight_id)
    .single();
  if (flightErr || !flight) return { ok: false, status: 404, error: "Flight not found" };

  const { data: employees, error: empErr } = await supabase.from("employees").select("*");
  if (empErr) return { ok: false, status: 500, error: empErr.message };

  const rawTargetFlight = flight as Flight;

  // The requirement's OWN flight determines which week's plan to score
  // against — never a fixed global week constant (see this function's
  // own doc comment above for the bug this replaced).
  const weekStart = weekStartFor(rawTargetFlight.flight_date);
  const { data: planRows } = await supabase.from("weekly_plans").select("*").eq("id", planIdForWeek(weekStart));
  const plan = (planRows as WeeklyPlan[] | null)?.[0];
  const effectiveConfig = plan?.config_snapshot;
  if (!plan || !effectiveConfig) {
    return { ok: false, status: 409, error: "No plan exists for this requirement's week — generate one first." };
  }

  const [{ data: allAssignments, error: assignErr }, { data: allRequirements, error: allReqErr }, { data: allFlights, error: allFlightErr }] =
    await Promise.all([
      supabase.from("assignments").select("*"),
      supabase.from("staffing_requirements").select("*"),
      supabase.from("flights").select("*"),
    ]);
  if (assignErr || allReqErr || allFlightErr) {
    return { ok: false, status: 500, error: (assignErr || allReqErr || allFlightErr)!.message };
  }

  // Operational-delay fix (2026-10-04): getRequirementWindow deliberately
  // never reads actual_departure (see lib/flight-operations.ts's own doc
  // comment) -- every caller is responsible for feeding it a shallow copy
  // with scheduled_departure substituted by effectiveDeparture() when it
  // needs the REAL, live time. This function never did that, which was
  // invisible for ordinary draft-plan candidate lookups (no flight has an
  // actual_departure yet at that stage) but silently wrong for its OTHER
  // real caller -- lib/live-ops-service.ts's delay-conflict flow -- where
  // it matters most: a flight that was JUST delayed still had its
  // replacement candidates (and every other employee's busy windows below)
  // scored against the flight's ORIGINAL scheduled time, not the real new
  // time the task now needs covering. A candidate whose shift doesn't
  // reach anywhere near the real new window could still come back
  // "recommended, no extension required" simply because the stale window
  // fit their shift fine. Applied once, up front, to every flight (not
  // just the target one) so an already-delayed OTHER flight's busy window
  // below is equally correct -- for any flight with no actual_departure
  // set, effectiveDeparture() falls back to scheduled_departure, so this
  // is a no-op and every existing (non-delayed) caller is unaffected.
  const effectiveFlights = (allFlights as Flight[]).map((f) => ({ ...f, scheduled_departure: effectiveDeparture(f) }));
  const targetFlight = effectiveFlights.find((f) => f.id === rawTargetFlight.id) ?? rawTargetFlight;

  const requirementAssignments = (allAssignments as Assignment[]).filter(
    (a) => a.staffing_requirement_id === requirement.id
  );
  const excludeIds = new Set([...requirementAssignments.map((a) => a.employee_id), ...(options?.excludeEmployeeIds ?? [])]);
  const notYetAssigned = (employees as Employee[]).filter((e) => !excludeIds.has(e.id));

  const rosterRows = plan ? await fetchAllRosterEntriesForPlan(supabase, plan.id) : ([] as WeeklyPlanRosterEntry[]);

  // OVERNIGHT CARRYOVER (2026-10-06 activation) — so Find Agent / Live
  // Operations can find an employee whose overnight shift (AP03, AP04,
  // NT01, N8) STARTED the day before this requirement's flight and still
  // reaches it (see buildDayEffectivePoolFromRosterEntries' own doc
  // comment). For the week's own Monday, "yesterday" is the PRIOR week's
  // Sunday — a different plan's roster, fetched only when actually needed
  // (never for the other six days, which already have their predecessor
  // in `rosterRows`).
  const targetDayIndex = DAYS_ORDER.indexOf(targetFlight.day_of_week);
  const previousDayOfWeek = DAYS_ORDER[(targetDayIndex + DAYS_ORDER.length - 1) % DAYS_ORDER.length];
  const isWeekStart = targetDayIndex === 0;
  const previousDate = isWeekStart ? flightDateFor(previousWeekStart(weekStart), previousDayOfWeek) : flightDateFor(weekStart, previousDayOfWeek);
  const previousRosterRows = isWeekStart
    ? await fetchAllRosterEntriesForPlan(supabase, planIdForWeek(previousWeekStart(weekStart)))
    : rosterRows;

  const candidatePool = buildDayEffectivePoolFromRosterEntries(
    notYetAssigned,
    rosterRows,
    targetFlight.day_of_week,
    targetFlight.flight_date,
    { dayOfWeek: previousDayOfWeek, date: previousDate, rosterEntries: previousRosterRows }
  );

  const window: TimeWindow = getRequirementWindow(requirement, targetFlight);

  const occupiedWindows = computeBusyWindowsForDay(
    targetFlight.day_of_week,
    allAssignments as Assignment[],
    allRequirements as StaffingRequirement[],
    effectiveFlights,
    candidatePool
  );

  const requiredAuthorization = requirement.source === "company_config" ? targetFlight.airline : undefined;

  const tasksAssignedThisScope = new Map<string, number>();
  for (const a of allAssignments as Assignment[]) {
    const r = (allRequirements as StaffingRequirement[]).find((req) => req.id === a.staffing_requirement_id);
    const f = r && (allFlights as Flight[]).find((fl) => fl.id === r.flight_id);
    if (!f || f.flight_date !== targetFlight.flight_date) continue;
    tasksAssignedThisScope.set(a.employee_id, (tasksAssignedThisScope.get(a.employee_id) ?? 0) + 1);
  }

  // FATIGUE (2026-10-06 activation) -- gives Find Agent/Live Operations
  // replacement ranking the SAME fatigueWeight dimension Stage 9 duty
  // generation already uses, never a second fatigue model: each
  // candidate's state ENTERING the target flight's day, derived through
  // the existing continuity-seed + day-by-day ledger machinery (see
  // fatigue-live-lookup.ts's own doc comment). A genuine no-op (empty map,
  // undefined input below) whenever fatigue is disabled -- byte-identical
  // to today's behavior in that case.
  let fatigue: CandidateFatigueInput | undefined;
  if (effectiveConfig.fatigue?.enabled) {
    const statesByEmployee = await buildFatigueStatesEnteringDate(
      supabase,
      effectiveConfig.fatigue,
      weekStart,
      DAYS_ORDER,
      targetFlight.flight_date,
      employees as Employee[],
      rosterRows
    );
    fatigue = { config: effectiveConfig.fatigue, statesByEmployee };
  }

  const candidates = scoreCandidates(
    requirement.role,
    window,
    candidatePool,
    effectiveConfig,
    occupiedWindows,
    requiredAuthorization,
    new Map(),
    tasksAssignedThisScope,
    fatigue
  );

  const exclusionSummary =
    candidates.length === 0
      ? buildExclusionSummary(requirement.role, window, notYetAssigned, candidatePool, occupiedWindows, requiredAuthorization)
      : undefined;

  return { ok: true, candidates, exclusionSummary, requirement: requirement as StaffingRequirement, flight: targetFlight, plan };
}
