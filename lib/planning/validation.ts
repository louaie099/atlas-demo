import { Employee, StaffingRequirement, Config } from "../types";
import { getShiftTimesAs, getShiftDurationHours } from "../shift-templates";
import { restHoursBetween } from "../roster-generation";
import { usesFixedCycleRotation } from "../teams";
import { checkConsecutiveOffCyclic } from "./consecutive-off";
// JR_NT_OFF_OFF_CYCLE is imported directly (not looked up per-team) because
// every fixed-cycle team today shares this one confirmed cycle definition
// (see lib/teams.ts's FIXED_CYCLE_TEAMS and lib/employee-generator.ts's
// FIXED_CYCLE_GROUPS). If a second, distinct fixed cycle is ever confirmed
// for a different team, this becomes a real per-team lookup then — not
// invented speculatively now.
import { JR_NT_OFF_OFF_CYCLE, maxConsecutiveOffInCycle } from "../fixed-cycle-rotation";

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

/**
 * Total scheduled hours across the week, computed from each employee's
 * weekly_shifts (real shift codes only — OFF days and days with no
 * assigned code contribute nothing). This is a real computation from the
 * generated/existing roster, not the static Employee.weekly_hours field
 * (which represents a separately-tracked running total, not derived from
 * this week's shifts specifically).
 */
export function computeScheduledWeeklyHours(employee: Employee): number {
  let totalHours = 0;
  for (const entry of employee.weekly_shifts) {
    if (entry.status !== "working" || !entry.shift_code) continue;
    // getShiftDurationHours (lib/shift-templates.ts) is the one shared
    // duration implementation -- handles the overnight wrap (AP03, AP04,
    // NT01, N8) itself, so this never re-derives its own diff-and-wrap
    // logic here.
    totalHours += getShiftDurationHours(entry.shift_code);
  }
  return Math.round(totalHours * 10) / 10;
}

/**
 * Checks rest between each pair of CONSECUTIVE working days in
 * daysOrder, PLUS the cyclic Sunday -> following-Monday boundary — a
 * genuinely week-level check, distinct from the existing single-day
 * "would need a shift extension" logic in scoring.ts. Returns one issue
 * per violation found.
 *
 * Any pair of working days separated by one or more OFF days in between
 * is never at risk here: a full OFF day is always >= 24h of separation
 * once the OFF day's own bracketing shifts are accounted for, comfortably
 * clearing the confirmed 15h floor, so this only needs to check
 * CALENDAR-ADJACENT working-day pairs (today -> tomorrow) — exactly what
 * the index loop below does. The one gap that calendar-adjacency inside a
 * single Monday-Sunday window misses entirely is the week boundary
 * itself: this week's Sunday shift and NEXT week's Monday shift are also
 * calendar-adjacent in a continuously-operating roster (Transit/Leaders'
 * fixed JR->NT->OFF->OFF cycle, most notably), so that pair is checked
 * explicitly too, exactly like lib/planning/consecutive-off.ts's own
 * cyclic (week-wrapping) consecutive-OFF check.
 */
export function checkRestBetweenDays(employee: Employee, daysOrder: string[], config: Config): PlanIssue[] {
  const issues: PlanIssue[] = [];

  function checkPair(todayLabel: string, tomorrowLabel: string, tomorrowIssueDay: string): void {
    const today = employee.weekly_shifts.find((s) => s.day_of_week === todayLabel);
    const tomorrow = employee.weekly_shifts.find((s) => s.day_of_week === tomorrowLabel);
    if (today?.status !== "working" || !today.shift_code) return;
    if (tomorrow?.status !== "working" || !tomorrow.shift_code) return;

    const todayShift = getShiftTimesAs(today.shift_code);
    const tomorrowShift = getShiftTimesAs(tomorrow.shift_code);

    // restHoursBetween needs the PREVIOUS shift's own start too, not just
    // its end -- an overnight previous shift (e.g. AP03 17:45-02:00) ends
    // on the FOLLOWING calendar day already, and clock-time subtraction
    // alone (treating "02:00" as if it were still today) would silently
    // overcount rest by a full 24h. See roster-generation.ts's
    // restHoursBetween doc comment.
    const restHours = restHoursBetween(todayShift.shift_start, todayShift.shift_end, tomorrowShift.shift_start);

    if (restHours < config.minimum_rest_hours) {
      issues.push({
        type: "rest_violation",
        employeeId: employee.id,
        dayOfWeek: tomorrowIssueDay,
        description: `${employee.name}: only ${restHours.toFixed(1)}h rest between ${todayLabel} (ends ${todayShift.shift_end}) and ${tomorrowLabel} (starts ${tomorrowShift.shift_start}) — minimum required is ${config.minimum_rest_hours}h.`,
      });
    }
  }

  for (let i = 0; i < daysOrder.length - 1; i++) {
    checkPair(daysOrder[i], daysOrder[i + 1], daysOrder[i + 1]);
  }
  // Cyclic week-boundary pair: this week's last day -> next week's first
  // day (e.g. Sunday -> the following Monday), relevant to any
  // continuously-operating roster whose pattern doesn't reset at the
  // display week's edge. Only meaningful when daysOrder is the FULL
  // 7-day week (so "wrap to index 0" really means "the following
  // Monday") -- a partial slice (e.g. two arbitrary adjacent days passed
  // directly in a unit test) has no real "following week" boundary at
  // its end, and must not be treated as one.
  if (daysOrder.length === 7) {
    checkPair(daysOrder[daysOrder.length - 1], daysOrder[0], `${daysOrder[0]} (following week)`);
  }

  return issues;
}

/**
 * Confirmed hard constraint (see lib/labor-rules.ts's
 * maximumWeeklyWorkingHours, 42h): sum of counted working duration across
 * the week must not exceed it. This is the FINAL-VALIDATION half of the
 * gate — it must never be the only place this is checked (a roster that
 * violates 42h must not be generated in the first place and then merely
 * displayed as a warning here); see lib/planning/shift-generation.ts for
 * the generation-time half, which refuses to hand the flexible pool a
 * shift that would push them over the ceiling before it's ever chosen.
 * This function still runs across EVERY employee, including static/
 * fixed-shift categories shift-generation.ts never touches, so a
 * structurally-infeasible existing pattern (a single repeated shift code
 * with no per-day variation) is still reported here even though nothing
 * upstream could have prevented it — see auditStaticShiftHoursFeasibility
 * below for surfacing that as a configuration-level gap instead of a
 * per-week surprise.
 */
export function checkWeeklyHoursCeiling(employee: Employee, config: Config): PlanIssue | null {
  const scheduled = computeScheduledWeeklyHours(employee);
  if (scheduled > config.maximum_weekly_working_hours) {
    return {
      type: "weekly_hours_violation",
      employeeId: employee.id,
      description: `${employee.name}: scheduled ${scheduled}h this week, above the confirmed ${config.maximum_weekly_working_hours}h weekly ceiling.`,
    };
  }
  return null;
}

/**
 * A CONFIGURATION-level feasibility gap (see ConfigurationIssue's doc
 * comment above), not a per-week Plan Warning: an employee whose weekly
 * schedule is NOT decided day-by-day during plan generation (anyone
 * outside the flexible General T1 pool -- a fixed single shift_code
 * repeated on every working day, a foreign-company commitment pattern
 * baked in at seed time, or a fixed JR/NT/OFF/OFF cycle) cannot have its
 * weekly-hours problem "solved" by generation at all: there is no day-by-
 * day choice left to make once their pattern is already fixed. If that
 * fixed pattern's counted hours exceed the confirmed 42h ceiling, this is
 * a genuine workforce-design/capacity problem (the assigned shift code is
 * simply too long for 5 working days under a flat 2-day-off week, and the
 * shift catalog has no shorter code available for that role) — true
 * regardless of which week you look at, exactly like a missing RAM
 * staffing-matrix rule. It is surfaced here rather than silently
 * resolved by inventing an extra OFF day (explicitly forbidden) or a new
 * shift code that isn't in the authoritative catalog.
 */
export function auditStaticShiftHoursFeasibility(
  employees: Employee[],
  isFlexible: (e: Employee) => boolean,
  config: Config
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  for (const employee of employees) {
    if (isFlexible(employee)) continue; // day-by-day generation already enforces the ceiling for these
    const scheduled = computeScheduledWeeklyHours(employee);
    if (scheduled > config.maximum_weekly_working_hours) {
      issues.push({
        requirementId: `capacity-${employee.id}`,
        description: `${employee.name} (${employee.assignment}): fixed weekly pattern totals ${scheduled}h, above the confirmed ${config.maximum_weekly_working_hours}h ceiling, with no per-day shift variation available to reduce it without adding an OFF day beyond the confirmed entitlement. Requires either a shorter compatible shift code for this role or a workforce-design decision — not something ATLAS can resolve automatically.`,
      });
    }
  }
  return issues;
}

/**
 * The same CONFIGURATION-level treatment as auditStaticShiftHoursFeasibility
 * above, but for the confirmed 15h minimum inter-shift rest rule instead
 * of the 42h ceiling. An employee whose weekly schedule isn't decided
 * day-by-day during generation (anyone outside the flexible General T1
 * pool) simply repeats the SAME shift code on every working day with no
 * OFF day in between (Monday->Tuesday, Tuesday->Wednesday, etc.) — if
 * that single code's own day-to-day rest gap (24h - duration) falls
 * below the confirmed 15h floor, no day-by-day choice generation could
 * ever have made would fix it: the code itself is the problem, exactly
 * like an over-long shift code is for the 42h ceiling. This is a
 * genuine workforce-design/capacity gap, not a per-week Plan Warning
 * "surprise" and not something to silently resolve by inventing a new
 * shift code or an extra OFF day.
 *
 * NOTE: this only audits the EMPLOYEE'S OWN in-place repeating pattern
 * (checkRestBetweenDays against their static weekly_shifts) — it is
 * distinct from, and does not replace, checkRestBetweenDays being run
 * as a per-week PlanIssue against every employee (flexible included) in
 * validateWeeklyPlan, which is what actually surfaces this to the
 * routine Weekly Planning UI today.
 */
export function auditStaticShiftRestFeasibility(
  employees: Employee[],
  isFlexible: (e: Employee) => boolean,
  config: Config
): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  for (const employee of employees) {
    if (isFlexible(employee)) continue; // day-by-day generation already enforces this rule for these, at selection time
    const daysOrder = employee.weekly_shifts.map((s) => s.day_of_week);
    const restIssues = checkRestBetweenDays(employee, daysOrder, config);
    if (restIssues.length > 0) {
      const worst = restIssues.reduce((min, i) => {
        const m = i.description.match(/only ([\d.]+)h rest/);
        const hours = m ? parseFloat(m[1]) : Infinity;
        return hours < min ? hours : min;
      }, Infinity);
      issues.push({
        requirementId: `rest-capacity-${employee.id}`,
        description: `${employee.name} (${employee.assignment}): fixed weekly pattern's repeating shift code yields as little as ${worst}h rest between consecutive working days, below the confirmed ${config.minimum_rest_hours}h minimum, with no per-day shift variation available to fix it. Requires either a different compatible shift code for this role or a workforce-design decision — not something ATLAS can resolve automatically.`,
      });
    }
  }
  return issues;
}

/**
 * Confirmed labor-rule constraint: max CONSECUTIVE OFF days (resolved via
 * config.max_consecutive_off_days — see lib/labor-rules.ts), evaluated
 * across week boundaries (see lib/planning/consecutive-off.ts).
 *
 * A team on a confirmed continuous FIXED CYCLE (Transit/Leaders — see
 * lib/fixed-cycle-rotation.ts) is period-4, not period-7, so wrapping
 * their single displayed Monday-Sunday snapshot onto itself would
 * misrepresent their real continuous schedule. They are still subject to
 * the SAME resolved labor protection, though — not skipped outright: the
 * real continuous cycle's own maxConsecutiveOffInCycle is validated
 * against config.max_consecutive_off_days instead of the weekly snapshot.
 * The rotation policy (the JR->NT->OFF->OFF sequence itself) stays
 * entirely in lib/fixed-cycle-rotation.ts — this only checks that the
 * cycle SATISFIES the labor rule, never redefines or overrides it.
 */
export function checkConsecutiveOff(employee: Employee, config: Config): PlanIssue | null {
  if (usesFixedCycleRotation(employee.assignment)) {
    const cycleMax = maxConsecutiveOffInCycle(JR_NT_OFF_OFF_CYCLE);
    if (cycleMax > config.max_consecutive_off_days) {
      return {
        type: "consecutive_off_violation",
        employeeId: employee.id,
        description: `${employee.name}: the ${employee.assignment} fixed cycle has ${cycleMax} consecutive OFF days in its continuous rotation — above the confirmed maximum of ${config.max_consecutive_off_days}.`,
      };
    }
    return null;
  }
  const violation = checkConsecutiveOffCyclic(employee, config.max_consecutive_off_days);
  if (!violation) return null;
  return {
    type: "consecutive_off_violation",
    employeeId: employee.id,
    description: `${employee.name}: ${violation.maxConsecutiveOffDays} consecutive OFF days (evaluated across the week boundary) — above the confirmed maximum of ${config.max_consecutive_off_days}.`,
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
    const consecutiveOffIssue = checkConsecutiveOff(employee, config);
    if (consecutiveOffIssue) issues.push(consecutiveOffIssue);
  }

  return issues;
}
