import { Employee, Flight, StaffingRequirement, Assignment, Config, WeeklyPlanRosterEntry } from "../types";
import { scoreCandidates, TimeWindow } from "../scoring";
import { getRequirementWindow } from "./requirement-window";
import { getEmployeeForeignCommitments } from "../foreign-company-window";
import { GeneratedShiftAssignment } from "./shift-generation";
import { getShiftTimesAs } from "../shift-templates";
import { isFlexibleGeneralPool } from "./workforce-pools";

export interface GeneratedDuty {
  requirementId: string;
  flightId: string;
  employeeId: string;
  role: string;
  window: TimeWindow;
  reasoning: string;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return timeToMinutes(a.start) < timeToMinutes(b.end) && timeToMinutes(b.start) < timeToMinutes(a.end);
}

/**
 * Builds each employee's EFFECTIVE shift for a specific day. For a
 * FLEXIBLE POOL employee, the freshly GENERATED demand-driven shift
 * (Stage 6) takes priority over whatever static baseline code they carry
 * in weekly_shifts — that baseline is a pre-planning placeholder, not a
 * real commitment, and letting it win would silently reproduce exactly
 * the "one static shift for the whole week" pattern the brief explicitly
 * rules out. If generation didn't select them that day (not needed for
 * tracked demand), they fall back to their existing entry so they're not
 * simply erased from the day.
 *
 * For a NON-flexible employee (foreign-committed, fixed/specialized team,
 * Transit), the existing weekly_shifts entry IS their real, already-
 * established commitment and is used as-is — generation never touches
 * these employees, so there's nothing to prioritize over.
 */
export function effectiveShiftForDay(
  employee: Employee,
  dayOfWeek: string,
  generatedShifts: GeneratedShiftAssignment[]
): { shift_start: string; shift_end: string } | null {
  const existing = employee.weekly_shifts.find((s) => s.day_of_week === dayOfWeek);
  if (existing?.status === "off") return null;

  if (isFlexibleGeneralPool(employee)) {
    const generated = generatedShifts.find((g) => g.employeeId === employee.id && g.dayOfWeek === dayOfWeek);
    if (generated) return getShiftTimesAs(generated.shiftCode);
    if (existing?.shift_code) return getShiftTimesAs(existing.shift_code);
    return null;
  }

  if (existing?.shift_code) return getShiftTimesAs(existing.shift_code);
  return null; // not rostered this day — never a candidate for a duty that day
}

/**
 * Same effective-shift logic as effectiveShiftForDay above, but returns the
 * shift CODE ("MT02") rather than resolved start/end times — what Agent
 * Schedule's day-by-day grid needs to display. Kept as a separate function
 * rather than changing effectiveShiftForDay's return shape, to avoid
 * touching that function's existing callers/tests.
 */
export function effectiveShiftCodeForDay(
  employee: Employee,
  dayOfWeek: string,
  generatedShifts: GeneratedShiftAssignment[]
): string | null {
  const existing = employee.weekly_shifts.find((s) => s.day_of_week === dayOfWeek);
  if (existing?.status === "off") return null;

  if (isFlexibleGeneralPool(employee)) {
    const generated = generatedShifts.find((g) => g.employeeId === employee.id && g.dayOfWeek === dayOfWeek);
    if (generated) return generated.shiftCode;
    return existing?.shift_code ?? null;
  }

  return existing?.shift_code ?? null;
}

/**
 * Resolves ONE employee's plan-scoped roster entry for one day -- the
 * single function that produces what becomes a persisted
 * WeeklyPlanRosterEntry row (see lib/types.ts), for every employee group
 * alike (fixed-cycle, foreign-committed, flexible General T1 Pool). Same
 * effective-shift logic as effectiveShiftForDay/effectiveShiftCodeForDay
 * above, restated here to also produce the explicit "working"/"off"
 * status a roster row needs (those two functions return null for both
 * "off" and "not rostered at all", which is the right behavior for
 * candidate-pool building but not enough to persist a row).
 *
 * This is generation-time input resolution -- it reads Employee.weekly_shifts
 * as the baseline/template it still legitimately is (see lib/types.ts's
 * Employee doc comment). Once the result is persisted as a
 * WeeklyPlanRosterEntry, THAT row -- not a re-read of Employee.weekly_shifts
 * -- is what every later read of this plan must use.
 */
export function resolvePlanRosterEntry(
  employee: Employee,
  dayOfWeek: string,
  generatedShifts: GeneratedShiftAssignment[]
): { status: "working" | "off"; shift_code: string | null } {
  const existing = employee.weekly_shifts.find((s) => s.day_of_week === dayOfWeek);
  if (existing?.status === "off") return { status: "off", shift_code: null };

  if (isFlexibleGeneralPool(employee)) {
    const generated = generatedShifts.find((g) => g.employeeId === employee.id && g.dayOfWeek === dayOfWeek);
    if (generated) return { status: "working", shift_code: generated.shiftCode };
    if (existing?.shift_code) return { status: "working", shift_code: existing.shift_code };
    return { status: "off", shift_code: null }; // not selected for a generated shift and no baseline -- not planned to work
  }

  if (existing?.shift_code) return { status: "working", shift_code: existing.shift_code };
  return { status: "off", shift_code: null }; // no roster entry at all for this day -- treated the same as off, matching AgentDayEntry's existing isOff semantics
}

/**
 * Same day-effective-pool gate generation itself uses (see
 * generateDutiesForDay below), but sourced from a PERSISTED
 * WeeklyPlanRosterEntry set instead of live Employee.weekly_shifts +
 * freshly-computed generated shifts. This is what the Find Agent
 * candidates API and the Assign API's server-side re-validation must use
 * instead of scoring raw Employee rows directly -- scoreCandidates alone
 * only checks that an employee HAS some shift profile (non-null
 * shift_start/shift_end), never whether they are actually working on the
 * specific day in question. Without this gate, a human could manually
 * assign an employee on their scheduled day off -- silently overriding a
 * fixed labor-rule protection (e.g. max consecutive off days) that ATLAS's
 * own generation is never allowed to violate. Excludes anyone with no
 * roster entry for the day or a status of "off"; everyone else gets their
 * shift_start/shift_end substituted from their persisted roster shift_code
 * so scoreCandidates' rest/extension math reflects THIS plan's actual
 * roster, not a stale static baseline.
 */
export function buildDayEffectivePoolFromRosterEntries(
  employees: Employee[],
  rosterEntries: WeeklyPlanRosterEntry[],
  dayOfWeek: string
): Employee[] {
  const byEmployee = new Map<string, WeeklyPlanRosterEntry>();
  for (const entry of rosterEntries) {
    if (entry.day_of_week === dayOfWeek) byEmployee.set(entry.employee_id, entry);
  }

  return employees
    .map((e) => {
      const entry = byEmployee.get(e.id);
      if (!entry || entry.status === "off" || !entry.shift_code) return null;
      const times = getShiftTimesAs(entry.shift_code);
      return { ...e, shift_start: times.shift_start, shift_end: times.shift_end } as Employee;
    })
    .filter((e): e is Employee => e !== null);
}

/**
 * Stage 9 of the planning pipeline: assigning actual flight duties, one
 * requirement at a time, ONLY after shifts for the day already make
 * sense (Stages 6–8 done). Requirements are processed in departure-time
 * order so that an employee assigned to an earlier duty is correctly
 * excluded from a later, overlapping one — busy windows accumulate
 * across the pass, reusing the exact same overlap-exclusion mechanism
 * scoreCandidates already uses for foreign commitments
 * (occupiedWindows), just fed by this function instead of only
 * getEmployeeForeignCommitments.
 *
 * Only "recommended" candidates are auto-assigned in the draft — a
 * "flagged" candidate (e.g. would need a shift extension, or is near the
 * fairness ceiling) is left for human review rather than silently
 * auto-picked, consistent with "ATLAS recommends, humans approve."
 */
/**
 * Every window a given day's already-persisted Assignments make an
 * employee unavailable for — the shared overlap-exclusion input for
 * scoreCandidates, used identically by duty-generation (draft-plan
 * generation), the Find Agent candidates API, and the Assign API's own
 * server-side re-validation, so the three can never drift apart.
 *
 * Two sources, both included:
 *  1. Foreign-company commitments (getEmployeeForeignCommitments) — the
 *     WIDER protected window (4h30 before departure), deliberately
 *     broader than the requirement's own window.
 *  2. EVERY other existing Assignment for the day, RAM or company_config
 *     alike, using that requirement's own window. This is what prevents
 *     an employee already confirmed for one requirement (Gate, say) from
 *     also being recommended/assignable to a different, overlapping
 *     requirement (Boarding) on the same or another flight that day —
 *     the "Sara Bennis on both Gate and Boarding" bug.
 */
export function computeBusyWindowsForDay(
  dayOfWeek: string,
  existingAssignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  allEmployees: Employee[]
): Record<string, TimeWindow[]> {
  const busyWindows: Record<string, TimeWindow[]> = {};

  for (const employee of allEmployees) {
    const commitments = getEmployeeForeignCommitments(employee.id, existingAssignments, requirements, flights).filter(
      (c) => c.dayOfWeek === dayOfWeek
    );
    if (commitments.length > 0) busyWindows[employee.id] = commitments.map((c) => c.window);
  }

  for (const assignment of existingAssignments) {
    const requirement = requirements.find((r) => r.id === assignment.staffing_requirement_id);
    if (!requirement) continue;
    const flight = flights.find((f) => f.id === requirement.flight_id);
    if (!flight || flight.day_of_week !== dayOfWeek) continue;
    const window = getRequirementWindow(requirement, flight);
    busyWindows[assignment.employee_id] = [...(busyWindows[assignment.employee_id] ?? []), window];
  }

  return busyWindows;
}

export function generateDutiesForDay(
  dayOfWeek: string,
  requirements: StaffingRequirement[],
  flights: Flight[],
  allEmployees: Employee[],
  generatedShifts: GeneratedShiftAssignment[],
  existingAssignments: Assignment[],
  config: Config
): { duties: GeneratedDuty[]; unfilled: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[] } {
  const dayFlightIds = new Set(flights.filter((f) => f.day_of_week === dayOfWeek).map((f) => f.id));
  const dayRequirements = requirements
    .filter((r) => dayFlightIds.has(r.flight_id) && !r.needs_configuration)
    .map((r) => ({ requirement: r, flight: flights.find((f) => f.id === r.flight_id)! }))
    .sort((a, b) => a.flight.scheduled_departure.localeCompare(b.flight.scheduled_departure));

  const busyWindows = computeBusyWindowsForDay(dayOfWeek, existingAssignments, requirements, flights, allEmployees);

  const duties: GeneratedDuty[] = [];
  const unfilled: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[] = [];

  for (const { requirement, flight } of dayRequirements) {
    const window = getRequirementWindow(requirement, flight);
    const alreadyAssignedToThisRequirement = existingAssignments.filter(
      (a) => a.staffing_requirement_id === requirement.id
    ).length;
    const stillNeeded = requirement.total_requirement - alreadyAssignedToThisRequirement - duties.filter((d) => d.requirementId === requirement.id).length;
    if (stillNeeded <= 0) continue;

    // Build day-effective candidate pool: only employees actually
    // rostered this day, with their real shift for THIS day substituted
    // in — this is the day-aware reuse of scoreCandidates.
    const dayEffectivePool = allEmployees
      .map((e) => {
        const effective = effectiveShiftForDay(e, dayOfWeek, generatedShifts);
        if (!effective) return null;
        return { ...e, shift_start: effective.shift_start, shift_end: effective.shift_end } as Employee;
      })
      .filter((e) => e !== null) as Employee[];

    // A company_config (foreign-carrier) requirement is never filled via a
    // skill match -- there is no real "Company Team" flight-task skill,
    // only real authorization for THIS specific company (see
    // scoring.ts's requiredAuthorization param). Every other requirement
    // (Gate/Boarding/Profiling/Mesure/Check-in) is untouched: role-based
    // skill matching, exactly as before.
    const requiredAuthorization = requirement.source === "company_config" ? flight.airline : undefined;
    const results = scoreCandidates(requirement.role, window, dayEffectivePool, config, busyWindows, requiredAuthorization);
    const recommended = results.filter((r) => r.status === "recommended");

    let filled = 0;
    for (const candidate of recommended) {
      if (filled >= stillNeeded) break;
      duties.push({
        requirementId: requirement.id,
        flightId: flight.id,
        employeeId: candidate.employee.id,
        role: requirement.role,
        window,
        reasoning: candidate.reasoning,
      });
      busyWindows[candidate.employee.id] = [...(busyWindows[candidate.employee.id] ?? []), window];
      filled++;
    }

    if (filled < stillNeeded) {
      unfilled.push({ dayOfWeek, requirementId: requirement.id, role: requirement.role, stillNeeded: stillNeeded - filled });
    }
  }

  return { duties, unfilled };
}
