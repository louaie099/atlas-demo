import { Employee, Config, CandidateResult } from "./types";
import { isFixedPlanningTeam, isTransitTeam } from "./teams";

export interface TimeWindow {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
}

// An employee with a real, roster-assigned shift for scoring purposes.
type RosteredEmployee = Employee & { shift_start: string; shift_end: string; rest_before_shift_hours: number; weekly_hours: number };

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return timeToMinutes(a.start) < timeToMinutes(b.end) && timeToMinutes(b.start) < timeToMinutes(a.end);
}

function hasRosterAssigned(e: Employee): e is RosteredEmployee {
  return e.shift_start !== null && e.shift_end !== null && e.rest_before_shift_hours !== null && e.weekly_hours !== null;
}

/**
 * Ranks candidates for a staffing requirement by role. Role-agnostic —
 * used for Boarding (fixed-rule), Check-in (demand-forecast), and
 * foreign-company (company-config) gaps alike. Pure function: no I/O,
 * fully unit-testable.
 *
 * Exclusions happen before any scoring, and are not negotiable via
 * reasoning/flagging — these employees are never candidates, not even
 * flagged ones:
 *  - No roster/shift assigned yet (shift_start/shift_end/rest/weekly_hours
 *    are null) — a freshly-created employee has a workforce profile but
 *    no planning state until Weekly Planning assigns them a shift. There
 *    is nothing to evaluate rest/fairness/extension against, so they
 *    cannot be a candidate, flagged or otherwise, until they're rostered.
 *  - Fixed-planning teams (Leaders, Duty Officers, Caisse/BCB) follow
 *    specialized planning outside general ACE allocation.
 *  - Transit agents are committed to Transit for their full shift and are
 *    never available for any other role while on that team.
 *  - An employee with a protected foreign-company commitment (from a real,
 *    generated flight commitment for THIS specific date — see
 *    occupiedWindows below) whose window overlaps the requirement's own
 *    operational window. This is date/time-specific: the same employee
 *    remains eligible for a requirement outside that window, even on the
 *    same day, and remains eligible on other days entirely. Persistent
 *    foreign-company assignment/authorization alone never excludes
 *    anyone — only an actual overlapping commitment does.
 *
 * @param window The target requirement's own operational time window
 *   (e.g. a Boarding window, or an approximated Check-in window).
 * @param occupiedWindows Per-employee list of protected commitment windows
 *   for the SAME DATE as `window`, keyed by employee id. Typically derived
 *   from getEmployeeForeignCommitments(), filtered to the relevant day, by
 *   the caller — this function stays pure and doesn't fetch or compute
 *   commitments itself.
 * @param requiredAuthorization When set, eligibility is decided by real
 *   foreign-company AUTHORIZATION (`Employee.foreign_company_authorizations`
 *   includes this company name) instead of a flight-task skill match. This
 *   is how a company_config (foreign-carrier) requirement finds candidates
 *   — there is no employee "skill" that means "eligible for company X's
 *   ground operation"; authorization is the real, existing concept for
 *   that, not a manufactured qualification. Leave unset for every other
 *   requirement (Gate/Boarding/Profiling/Mesure/Check-in), which continue
 *   to match on `role` as a genuine trained capability.
 */
export function scoreCandidates(
  role: string,
  window: TimeWindow,
  employees: Employee[],
  config: Config,
  occupiedWindows: Record<string, TimeWindow[]> = {},
  requiredAuthorization?: string
): CandidateResult[] {
  const eligiblePool = employees.filter((e): e is RosteredEmployee => {
    if (!e.active) return false;
    if (!hasRosterAssigned(e)) return false;
    if (e.is_duty_officer) return false;
    if (isFixedPlanningTeam(e.assignment)) return false;
    if (isTransitTeam(e.assignment) && role !== "Transit") return false;
    if ((occupiedWindows[e.id] ?? []).some((occupied) => windowsOverlap(occupied, window))) return false;
    // Hard containment gate: a candidate whose shift doesn't overlap the
    // requirement's window AT ALL is not "a shift extension away" from
    // covering it -- they are simply not working anywhere near this flight,
    // and must never enter scoring. Previously this function only compared
    // shift END against window END (see extensionNeeded below), which
    // never rejected a candidate whose shift didn't overlap the window in
    // the first place -- e.g. a 13:45-22:45 shift was scored as eligible
    // for a 06:15-07:15 flight, because 22:45 >= 07:15 satisfied the only
    // check that existed. That is how duties ended up persisted outside
    // the employee's actual working interval (assignment.requirement_window
    // must be ⊆ roster_shift_window for anything auto-recommended). A
    // shift extension (late end, or now, early start -- see
    // earlyStartNeeded below) is still tolerated as a FLAGGED,
    // human-reviewed case, since the two windows genuinely overlap; total
    // non-overlap is excluded outright, never flagged.
    if (!windowsOverlap(window, { start: e.shift_start, end: e.shift_end })) return false;
    if (requiredAuthorization) return e.foreign_company_authorizations.includes(requiredAuthorization);
    return e.skills.includes(role);
  });

  const results: CandidateResult[] = eligiblePool.map((employee) => {
    const shiftEndMin = timeToMinutes(employee.shift_end);
    const windowEndMin = timeToMinutes(window.end);
    // A shift starting somewhat after the window's own start is normal and
    // expected, not a bug: the RAM window rule (getRequirementWindow) opens
    // a full T-1h/T-1h30 before departure as the IDEAL coverage start, but
    // an employee clocking in partway through that lead time and covering
    // the window through departure is exactly how real shift coverage
    // works -- that's what the hard eligiblePool overlap gate above already
    // protects (total non-overlap is excluded outright); only the shift
    // ending before the window ends is a genuine unplanned extension worth
    // flagging for human review.
    const extensionNeeded = shiftEndMin < windowEndMin;
    // maximum_weekly_working_hours is now a confirmed, always-a-number
    // ceiling (see lib/labor-rules.ts) — approaching it (within 5h) still
    // only flags a candidate for human review here; the HARD 42h cap
    // itself is enforced earlier, at shift generation/selection time (see
    // lib/planning/shift-generation.ts) and again at final validation
    // (lib/planning/validation.ts's checkWeeklyHoursCeiling), never
    // rescued by scoring.
    const nearCeiling = employee.weekly_hours >= config.maximum_weekly_working_hours - 5;
    const rested = employee.rest_before_shift_hours >= config.minimum_rest_hours;

    // Eligibility basis, stated honestly: a real trained skill for every
    // ordinary role, or a real company authorization for a foreign-carrier
    // requirement — never the same "qualified" phrasing for both, since
    // authorization isn't a flight-task skill.
    const eligibilityBasis = requiredAuthorization ? `${requiredAuthorization}-authorized` : `${role}-qualified`;

    if (rested && !extensionNeeded && !nearCeiling) {
      return {
        employee,
        status: "recommended",
        reasoning: `Currently on shift (${employee.shift_start}–${employee.shift_end}), ${eligibilityBasis}. ${employee.rest_before_shift_hours}h rest before shift (minimum required: ${config.minimum_rest_hours}h). Weekly hours: ${employee.weekly_hours}h — within the ${config.maximum_weekly_working_hours}h weekly ceiling. No extension required.`,
      };
    }

    const reasons: string[] = [];
    if (extensionNeeded) reasons.push("would require an unplanned shift extension with no rest window");
    if (nearCeiling) reasons.push(`weekly hours (${employee.weekly_hours}h) approaching the ${config.maximum_weekly_working_hours}h weekly ceiling`);
    if (!rested) reasons.push(`insufficient rest (${employee.rest_before_shift_hours}h, below the ${config.minimum_rest_hours}h minimum required)`);

    return {
      employee,
      status: "flagged",
      reasoning: `${eligibilityBasis}, but ${reasons.join("; ")}. Requires Duty Officer override to assign.`,
    };
  });

  return results.sort((a, b) => (a.status === b.status ? 0 : a.status === "recommended" ? -1 : 1));
}
