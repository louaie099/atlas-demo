import { Employee, Flight, Assignment, Config, StaffingRequirement } from "../types";
import { computeWeeklyStaffingRequirements } from "./weekly-requirements";
import { aggregateDailyDemand } from "./demand-aggregation";
import { generateFlexiblePoolShifts, GeneratedShiftAssignment, PriorDayShiftMap } from "./shift-generation";
import { generateDutiesForDay, GeneratedDuty, effectiveShiftForDay, resolvePlanRosterEntry } from "./duty-generation";
import { validateWeeklyPlan, collectConfigurationIssues, auditAverageWeeklyHoursFeasibility, auditStaticShiftRestFeasibility, PlanIssue, ConfigurationIssue } from "./validation";
import { isFlexibleGeneralPool } from "./workforce-pools";

/** The pure, not-yet-persisted shape of one WeeklyPlanRosterEntry row (see lib/types.ts) -- `plan_id`/`id` are added by the persistence layer, never computed here. */
export interface PlanRosterEntryDraft {
  employee_id: string;
  day_of_week: string;
  status: "working" | "off";
  shift_code: string | null;
}

export interface DraftWeeklyPlan {
  weekLabel: string;
  daysOrder: string[];
  requirements: StaffingRequirement[];
  generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>;
  dutiesByDay: Record<string, GeneratedDuty[]>;
  // The full, plan-scoped roster for the week -- every employee, every
  // day, "when are they planned to work and with what shift code" --
  // computed once here so persistence never has to re-derive it from
  // Employee.weekly_shifts later (see resolvePlanRosterEntry's doc
  // comment and lib/types.ts's WeeklyPlanRosterEntry).
  rosterEntries: PlanRosterEntryDraft[];
  // Operational Plan Warnings ONLY — rest/weekly-hours/consecutive-OFF
  // violations and unfilled duties. Never a configuration gap; see
  // configurationIssues below for that.
  issues: PlanIssue[];
  // Internal administrative/configuration gaps (no RAM staffing-matrix
  // rule for some aircraft/destination combination, or an unclassifiable
  // destination) — kept entirely separate from `issues` so nothing
  // downstream can fold them back into the operational summary. Reserved
  // for a future Administration/Configuration area; not surfaced in the
  // routine Weekly Planning UI today.
  configurationIssues: ConfigurationIssue[];
  generatedAt: string;
}

/**
 * The full pipeline, Stage 1 through Stage 10, orchestrated. This is a
 * PURE, READ-ONLY computation — it never writes to the database. It
 * reads the current flights/employees/existing assignments and returns a
 * draft; nothing is persisted until a future "publish" step (explicitly
 * out of scope for this pass — see the report's Stage 11 notes).
 *
 * Order matters and mirrors the brief exactly:
 *  1-2. Weekly requirements (Stage 1/4) — computeWeeklyStaffingRequirements
 *       already accounts for foreign-company requirements (Stage 2) via
 *       the same classification used everywhere else.
 *  3.   Fixed/specialized team recognition happens implicitly inside
 *       shift-generation (isFlexibleGeneralPool) and duty-generation
 *       (foreign commitments pre-populate busyWindows) — not a separate
 *       pass, since those exclusions are needed AT the point capacity is
 *       consumed, not before.
 *  5.   Demand aggregation, per day.
 *  6.   Flexible-pool shift generation, per day, from that day's demand —
 *       now cross-day rest-aware: `priorDayShift` is threaded from one day
 *       to the next (each employee's effective shift the day before), so
 *       a generated shift is never handed to someone it would leave
 *       under-rested for. See shift-generation.ts.
 *  7.   Profiling/Mesure: see specialized-demand.ts — deliberately not
 *       wired into requirement generation yet, since the rule for WHICH
 *       flights need them isn't confirmed, only the module shape is
 *       ready for when it is.
 *  8.   Reusing foreign-company ACEs outside their window: already true
 *       by construction — duty-generation only excludes an employee
 *       during their ACTUAL protected window (via occupiedWindows), never
 *       for their whole shift.
 *  9.   Individual duty generation, per day, in departure-time order.
 *  10.  Validation across the whole week.
 *
 * IMPORTANT — no calendar-week 42h gate: this pipeline used to reject a
 * candidate shift (and report a configuration gap) whenever it would
 * push a displayed-week total over the confirmed 42h number. That was
 * wrong: 42h is a confirmed AVERAGE (lib/labor-rules.ts's
 * maximumAverageWeeklyWorkingHours), not a Monday-Sunday ceiling, and the
 * real reference period it averages over is not yet confirmed (see
 * lib/planning/average-hours.ts). Generation therefore no longer rejects
 * anything on hours grounds, and validation no longer emits a
 * weekly_hours_violation or capacity ConfigurationIssue from a single
 * displayed week's total alone (checkAverageWeeklyHours/
 * auditAverageWeeklyHoursFeasibility in validation.ts return
 * not-evaluable/empty until a reference period is confirmed). The 15h
 * REST rule is unaffected — it is a genuinely continuous, per-transition
 * constraint (not a weekly sum) and remains hard-enforced exactly as
 * before, including the forward-looking check against each employee's
 * fixed baseline for the day after the display window ends.
 */
export function generateDraftWeeklyPlan(
  flights: Flight[],
  employees: Employee[],
  existingAssignments: Assignment[],
  config: Config,
  daysOrder: string[],
  weekLabel: string,
  // Optional cross-plan continuity seed: each employee's REAL effective
  // shift on the calendar day immediately before this window's first day
  // (e.g. the immediately preceding WeeklyPlan's actual Sunday roster —
  // see lib/planning/rotation-context.ts's deriveTransitionContext and
  // weekly-plan-service.ts's use of it). Without this, priorDayShift
  // would start empty and this window's Monday would never be
  // rest-checked against whatever the employee actually worked the day
  // before, which is exactly the kind of Monday-reset this milestone
  // corrects. Defaults to empty for a genuinely first-ever window (no
  // prior plan exists yet) — never a reason to skip the check when a
  // prior plan DOES exist.
  priorWeekBoundaryContext: PriorDayShiftMap = new Map()
): DraftWeeklyPlan {
  const requirements = computeWeeklyStaffingRequirements(flights, config);

  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  const dutiesByDay: Record<string, GeneratedDuty[]> = {};
  const allUnfilled: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[] = [];

  // Threaded day-to-day: each employee's effective shift on the previous
  // day, so Stage 6 can enforce rest when selecting today's shift. Seeded
  // from priorWeekBoundaryContext for the FIRST day of this window (see
  // that parameter's doc comment) rather than starting empty — this is
  // the concrete Sunday(week N) -> Monday(week N+1) continuity fix.
  let priorDayShift: PriorDayShiftMap = new Map(priorWeekBoundaryContext);

  for (let dayIndex = 0; dayIndex < daysOrder.length; dayIndex++) {
    const day = daysOrder[dayIndex];
    const demand = aggregateDailyDemand(day, flights, requirements);

    // The employee's own static baseline shift for the FOLLOWING day, if
    // one exists in this run -- see generateFlexiblePoolShifts's
    // nextDayBaselineShift doc comment for why this forward-looking
    // lookup is needed alongside priorDayShift. Wraps past the end of
    // daysOrder back to its own first day ONLY as a same-window
    // approximation when no real next window is known; a real prior/next
    // plan's actual roster (when available) is a strictly better source
    // and is what priorWeekBoundaryContext threads in from the other
    // direction for the window's own Monday.
    const nextDay = daysOrder[(dayIndex + 1) % daysOrder.length];
    const nextDayBaselineShift: PriorDayShiftMap = new Map();
    for (const employee of employees) {
      nextDayBaselineShift.set(employee.id, effectiveShiftForDay(employee, nextDay, []));
    }

    const generatedShifts = generateFlexiblePoolShifts(
      day,
      demand,
      employees,
      priorDayShift,
      config.minimum_rest_hours,
      undefined,
      nextDayBaselineShift
    );
    generatedShiftsByDay[day] = generatedShifts;

    const { duties, unfilled } = generateDutiesForDay(
      day,
      requirements,
      flights,
      employees,
      generatedShifts,
      existingAssignments,
      config
    );
    dutiesByDay[day] = duties;
    allUnfilled.push(...unfilled);

    const nextPriorDayShift: PriorDayShiftMap = new Map();
    for (const employee of employees) {
      nextPriorDayShift.set(employee.id, effectiveShiftForDay(employee, day, generatedShifts));
    }
    priorDayShift = nextPriorDayShift;
  }

  const issues = validateWeeklyPlan(allUnfilled, employees, daysOrder, config);
  const configurationIssues = [
    ...collectConfigurationIssues(requirements),
    // Average-hours feasibility: returns [] until a reference period is
    // confirmed (see auditAverageWeeklyHoursFeasibility's doc comment in
    // validation.ts) — never emitted from a single displayed week alone.
    ...auditAverageWeeklyHoursFeasibility(employees, isFlexibleGeneralPool, config),
    ...auditStaticShiftRestFeasibility(employees, isFlexibleGeneralPool, config),
  ];

  const rosterEntries: PlanRosterEntryDraft[] = [];
  for (const day of daysOrder) {
    for (const employee of employees) {
      const resolved = resolvePlanRosterEntry(employee, day, generatedShiftsByDay[day] ?? []);
      rosterEntries.push({ employee_id: employee.id, day_of_week: day, ...resolved });
    }
  }

  return {
    weekLabel,
    daysOrder,
    requirements,
    generatedShiftsByDay,
    dutiesByDay,
    rosterEntries,
    issues,
    configurationIssues,
    generatedAt: new Date().toISOString(),
  };
}
