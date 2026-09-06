import { Employee, StaffingRequirement, Config } from "../types";
import { getShiftTimesAs } from "../shift-templates";
import { restHoursBetween } from "../roster-generation";
import { usesFixedCycleRotation } from "../teams";
import { checkConsecutiveOffCyclic } from "./consecutive-off";

// "needs_configuration" was REMOVED from this type entirely — it isn't an
// operational planning problem, it's an internal administrative gap (no
// RAM staffing-matrix rule for some aircraft/destination combination). It
// used to be folded in here and then filtered back out downstream, which
// left it one refactor away from silently inflating the operational Plan
// Warnings count again. It's now a fully separate concept — see
// ConfigurationIssue and collectConfigurationIssues below — with its own
// field on DraftWeeklyPlan, never mixed into this array.
export type PlanIssueType = "unfilled_duty" | "rest_violation" | "weekly_hours_violation" | "consecutive_off_violation";

export interface PlanIssue {
  type: PlanIssueType;
  description: string;
  requirementId?: string;
  employeeId?: string;
  dayOfWeek?: string;
}

/**
 * An internal administrative/configuration gap — NOT an operational
 * planning problem. "Plan Warnings" (rest violations, weekly-hours
 * violations, consecutive-OFF violations, unfilled duties) describe
 * something wrong with THIS WEEK'S generated plan; a ConfigurationIssue
 * describes something missing from ATLAS's own RULEBOOK (no RAM staffing-
 * matrix entry for an aircraft/destination combination, or an
 * unclassifiable destination) — true regardless of which week you're
 * looking at, and never something a planner can "fix" by reassigning
 * someone. Kept in its own array so nothing downstream can accidentally
 * fold it into the operational summary again; a future Administration/
 * Configuration area is the natural place to surface these, not the
 * routine weekly Plan Warnings count.
 */
export interface ConfigurationIssue {
  requirementId: string;
  description: string;
}

/**
 * Collects every StaffingRequirement still marked needs_configuration —
 * always non-empty-reasoning, never a guessed rule. Kept separate from
 * validateWeeklyPlan (which computes true operational Plan Warnings) so
 * the two can never be accidentally merged into one count again.
 */
export function collectConfigurationIssues(requirements: StaffingRequirement[]): ConfigurationIssue[] {
  return requirements
    .filter((r) => r.needs_configuration)
    .map((r) => ({ requirementId: r.id, description: r.reasoning }));
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Total scheduled hours across the week, computed from each employee's
 * weekly_shifts (real shift codes only — OFF days and days with no
 * assigned code contribute nothing). This is a real computation from the
 * generated/existing roster, not the static Employee.weekly_hours field
 * (which represents a separately-tracked running total, not derived from
 * this week's shifts specifically).
 */
export function computeScheduledWeeklyHours(employee: Employee): number {
  let totalMinutes = 0;
  for (const entry of employee.weekly_shifts) {
    if (entry.status !== "working" || !entry.shift_code) continue;
    const { shift_start, shift_end } = getShiftTimesAs(entry.shift_code);
    let minutes = timeToMinutes(shift_end) - timeToMinutes(shift_start);
    if (minutes < 0) minutes += 24 * 60; // overnight shift
    totalMinutes += minutes;
  }
  return Math.round((totalMinutes / 60) * 10) / 10;
}

/**
 * Checks rest between each pair of CONSECUTIVE working days in
 * daysOrder — a genuinely week-level check, distinct from the existing
 * single-day "would need a shift extension" logic in scoring.ts. Returns
 * one issue per violation found.
 */
export function checkRestBetweenDays(employee: Employee, daysOrder: string[], config: Config): PlanIssue[] {
  const issues: PlanIssue[] = [];

  for (let i = 0; i < daysOrder.length - 1; i++) {
    const today = employee.weekly_shifts.find((s) => s.day_of_week === daysOrder[i]);
    const tomorrow = employee.weekly_shifts.find((s) => s.day_of_week === daysOrder[i + 1]);
    if (today?.status !== "working" || !today.shift_code) continue;
    if (tomorrow?.status !== "working" || !tomorrow.shift_code) continue;

    const todayShift = getShiftTimesAs(today.shift_code);
    const tomorrowShift = getShiftTimesAs(tomorrow.shift_code);

    const restHours = restHoursBetween(todayShift.shift_end, tomorrowShift.shift_start);

    if (restHours < config.minimum_rest_hours) {
      issues.push({
        type: "rest_violation",
        employeeId: employee.id,
        dayOfWeek: daysOrder[i + 1],
        description: `${employee.name}: only ${restHours.toFixed(1)}h rest between ${daysOrder[i]} (ends ${todayShift.shift_end}) and ${daysOrder[i + 1]} (starts ${tomorrowShift.shift_start}) — minimum required is ${config.minimum_rest_hours}h.`,
      });
    }
  }

  return issues;
}

/**
 * `config.fairness_ceiling_hours` may be the literal "unconfirmed" (see
 * lib/labor-rules.ts) — the prototype 40h value was deliberately NOT
 * carried forward as a number. An unconfirmed ceiling is never enforced:
 * this returns null rather than comparing scheduled hours against a
 * guessed figure. Once a real ceiling is confirmed, this starts reporting
 * again with no other change needed here.
 */
export function checkWeeklyHoursCeiling(employee: Employee, config: Config): PlanIssue | null {
  if (config.fairness_ceiling_hours === "unconfirmed") return null;
  const scheduled = computeScheduledWeeklyHours(employee);
  if (scheduled > config.fairness_ceiling_hours) {
    return {
      type: "weekly_hours_violation",
      employeeId: employee.id,
      description: `${employee.name}: scheduled ${scheduled}h this week, above the ${config.fairness_ceiling_hours}h fairness ceiling.`,
    };
  }
  return null;
}

/**
 * Confirmed global rest constraint: max 2 CONSECUTIVE OFF days, evaluated
 * across week boundaries (see lib/planning/consecutive-off.ts). A team on
 * a confirmed continuous FIXED CYCLE (Transit/Leaders — see
 * lib/fixed-cycle-rotation.ts) is period-4, not period-7: wrapping their
 * single displayed week onto itself would misrepresent their real
 * continuous schedule, so they're validated directly against the cycle
 * definition instead (guaranteed <= 2 by construction, exercised by
 * dedicated tests) and skipped here.
 */
export function checkConsecutiveOff(employee: Employee): PlanIssue | null {
  if (usesFixedCycleRotation(employee.assignment)) return null;
  const violation = checkConsecutiveOffCyclic(employee);
  if (!violation) return null;
  return {
    type: "consecutive_off_violation",
    employeeId: employee.id,
    description: `${employee.name}: ${violation.maxConsecutiveOffDays} consecutive OFF days (evaluated across the week boundary) — above the confirmed maximum of 2.`,
  };
}

/**
 * Stage 10 of the planning pipeline. Deliberately does NOT include a
 * separate overlap detector — generateDutiesForDay already prevents
 * overlapping assignments by construction (proven by
 * tests/duty-generation.test.ts), so a post-hoc overlap check here would
 * be redundant for anything this pipeline itself produced. It would only
 * matter for externally-supplied duties, which this stage doesn't
 * receive.
 */
export function validateWeeklyPlan(
  unfilledByDay: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[],
  employees: Employee[],
  daysOrder: string[],
  config: Config
): PlanIssue[] {
  const issues: PlanIssue[] = [];

  // needs_configuration requirements are NOT this function's concern at
  // all any more — see collectConfigurationIssues above, called
  // separately (generate-draft-plan.ts) into its own DraftWeeklyPlan
  // field, so a configuration gap can never inflate the operational Plan
  // Warnings count again.

  for (const u of unfilledByDay) {
    issues.push({
      type: "unfilled_duty",
      requirementId: u.requirementId,
      dayOfWeek: u.dayOfWeek,
      description: `${u.role} requirement on ${u.dayOfWeek} still needs ${u.stillNeeded} more — no qualified, available, rested employee found. This requirement cannot currently be covered.`,
    });
  }

  for (const employee of employees) {
    issues.push(...checkRestBetweenDays(employee, daysOrder, config));
    const hoursIssue = checkWeeklyHoursCeiling(employee, config);
    if (hoursIssue) issues.push(hoursIssue);
    const consecutiveOffIssue = checkConsecutiveOff(employee);
    if (consecutiveOffIssue) issues.push(consecutiveOffIssue);
  }

  return issues;
}
