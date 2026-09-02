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
 */
export function scoreCandidates(
  role: string,
  window: TimeWindow,
  employees: Employee[],
  config: Config,
  occupiedWindows: Record<string, TimeWindow[]> = {}
): CandidateResult[] {
  const eligiblePool = employees.filter((e): e is RosteredEmployee => {
    if (!e.active) return false;
    if (!hasRosterAssigned(e)) return false;
    if (e.is_duty_officer) return false;
    if (isFixedPlanningTeam(e.assignment)) return false;
    if (isTransitTeam(e.assignment) && role !== "Transit") return false;
    if ((occupiedWindows[e.id] ?? []).some((occupied) => windowsOverlap(occupied, window))) return false;
    return e.skills.includes(role);
  });

  const results: CandidateResult[] = eligiblePool.map((employee) => {
    const shiftEndMin = timeToMinutes(employee.shift_end);
    const windowEndMin = timeToMinutes(window.end);
    const extensionNeeded = shiftEndMin < windowEndMin;
    const nearCeiling = employee.weekly_hours >= config.fairness_ceiling_hours - 5;
    const rested = employee.rest_before_shift_hours >= config.minimum_rest_hours;

    if (rested && !extensionNeeded && !nearCeiling) {
      return {
        employee,
        status: "recommended",
        reasoning: `Currently on shift (${employee.shift_start}–${employee.shift_end}), ${role}-qualified. ${employee.rest_before_shift_hours}h rest before shift (minimum required: ${config.minimum_rest_hours}h). Weekly hours: ${employee.weekly_hours}h — within fairness range. No extension required.`,
      };
    }

    const reasons: string[] = [];
    if (extensionNeeded) reasons.push("would require an unplanned shift extension with no rest window");
    if (nearCeiling) reasons.push(`weekly hours (${employee.weekly_hours}h) approaching the ${config.fairness_ceiling_hours}h fairness ceiling`);
    if (!rested) reasons.push(`insufficient rest (${employee.rest_before_shift_hours}h, below the ${config.minimum_rest_hours}h minimum required)`);

    return {
      employee,
      status: "flagged",
      reasoning: `${role}-qualified, but ${reasons.join("; ")}. Requires Duty Officer override to assign.`,
    };
  });

  return results.sort((a, b) => (a.status === b.status ? 0 : a.status === "recommended" ? -1 : 1));
}
