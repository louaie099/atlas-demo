import { Employee, Config, CandidateResult } from "./types";
import { isFixedPlanningTeam, isTransitTeam } from "./teams";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Ranks candidates for a staffing requirement by role. Role-agnostic —
 * used for Boarding (fixed-rule), Check-in/ACE (demand-forecast), and
 * foreign-company (company-config) gaps alike. Pure function: no I/O,
 * fully unit-testable.
 *
 * Two structural exclusions happen before any scoring, and are not
 * negotiable via reasoning/flagging — these employees are never
 * candidates, not even flagged ones:
 *  - Fixed-planning teams (Leaders, Duty Officers, Caisse/BCB) follow
 *    specialized planning outside general ACE allocation.
 *  - Transit agents are committed to Transit for their full shift and are
 *    never available for any other role while on that team.
 */
export function scoreCandidates(
  role: string,
  windowEnd: string,
  employees: Employee[],
  config: Config
): CandidateResult[] {
  const eligiblePool = employees.filter((e) => {
    if (e.is_duty_officer) return false;
    if (isFixedPlanningTeam(e.default_team)) return false;
    if (isTransitTeam(e.default_team) && role !== "Transit") return false;
    return e.roles.includes(role);
  });

  const results: CandidateResult[] = eligiblePool.map((employee) => {
    const shiftEndMin = timeToMinutes(employee.shift_end);
    const windowEndMin = timeToMinutes(windowEnd);
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
