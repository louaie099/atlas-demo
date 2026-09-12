import { Employee, Flight, Assignment, Config, StaffingRequirement } from "../types";
import { computeWeeklyStaffingRequirements } from "./weekly-requirements";
import { aggregateDailyDemand } from "./demand-aggregation";
import { generateFlexiblePoolShifts, GeneratedShiftAssignment, PriorDayShiftMap } from "./shift-generation";
import { generateDutiesForDay, GeneratedDuty, effectiveShiftForDay, effectiveShiftCodeForDay, resolvePlanRosterEntry } from "./duty-generation";
import { validateWeeklyPlan, collectConfigurationIssues, auditStaticShiftHoursFeasibility, auditStaticShiftRestFeasibility, PlanIssue, ConfigurationIssue } from "./validation";
import { getShiftDurationHours } from "../shift-templates";
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
 */
export function generateDraftWeeklyPlan(
  flights: Flight[],
  employees: Employee[],
  existingAssignments: Assignment[],
  config: Config,
  daysOrder: string[],
  weekLabel: string
): DraftWeeklyPlan {
  const requirements = computeWeeklyStaffingRequirements(flights, config);

  const generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]> = {};
  const dutiesByDay: Record<string, GeneratedDuty[]> = {};
  const allUnfilled: { dayOfWeek: string; requirementId: string; role: string; stillNeeded: number }[] = [];

  // Threaded day-to-day: each employee's effective shift on the previous
  // day, so Stage 6 can enforce rest when selecting today's shift. Empty
  // on the first day of the week — nothing "before Monday" is modeled,
  // same scope validation.ts's own week-level rest check already has.
  let priorDayShift: PriorDayShiftMap = new Map();

  // Threaded day-to-day: each employee's cumulative counted hours from
  // every day processed so far this week (both Stage-6-generated picks
  // and static/baseline days alike) — the running total
  // generateFlexiblePoolShifts checks against the confirmed
  // maximumWeeklyWorkingHours ceiling BEFORE handing out each new day's
  // shift, so a 42h-violating roster is never generated in the first
  // place (see shift-generation.ts's hard gate).
  const hoursSoFarThisWeek = new Map<string, number>();

  for (let dayIndex = 0; dayIndex < daysOrder.length; dayIndex++) {
    const day = daysOrder[dayIndex];
    const demand = aggregateDailyDemand(day, flights, requirements);

    // The employee's own static baseline shift for the FOLLOWING day, if
    // one exists in this run -- see generateFlexiblePoolShifts's
    // nextDayBaselineShift doc comment for why this forward-looking
    // lookup is needed alongside priorDayShift.
    // Wraps past the end of daysOrder back to its own first day (the
    // following week's Monday), mirroring checkRestBetweenDays's own
    // cyclic week-boundary check -- a continuously-operating roster's
    // Sunday is calendar-adjacent to next week's Monday too, not just
    // the display week's own edge.
    const nextDay = daysOrder[(dayIndex + 1) % daysOrder.length];
    const nextDayBaselineShift: PriorDayShiftMap = new Map();
    for (const employee of employees) {
      nextDayBaselineShift.set(employee.id, effectiveShiftForDay(employee, nextDay, []));
    }

    // Conservative worst-case: each employee's own static baseline hours
    // for every day still ahead of today (this run hasn't decided those
    // days yet, so assume none of them get overridden) -- see
    // generateFlexiblePoolShifts's futureBaselineHours doc comment.
    const futureBaselineHours = new Map<string, number>();
    const futureDays = daysOrder.slice(dayIndex + 1);
    for (const employee of employees) {
      let total = 0;
      for (const futureDay of futureDays) {
        const entry = employee.weekly_shifts.find((s) => s.day_of_week === futureDay);
        if (entry?.status === "working" && entry.shift_code) {
          total += getShiftDurationHours(entry.shift_code);
        }
      }
      futureBaselineHours.set(employee.id, total);
    }

    const generatedShifts = generateFlexiblePoolShifts(
      day,
      demand,
      employees,
      priorDayShift,
      config.minimum_rest_hours,
      undefined,
      hoursSoFarThisWeek,
      config.maximum_weekly_working_hours,
      nextDayBaselineShift,
      futureBaselineHours
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

    // Accrue today's counted hours for EVERY employee (flexible-pool
    // picks and static/baseline days alike) so tomorrow's Stage 6
    // selection can see the true running total -- this is what makes the
    // 42h gate in shift-generation.ts a real WEEK-LEVEL constraint rather
    // than a per-day one.
    for (const employee of employees) {
      const code = effectiveShiftCodeForDay(employee, day, generatedShifts);
      if (code) {
        hoursSoFarThisWeek.set(employee.id, (hoursSoFarThisWeek.get(employee.id) ?? 0) + getShiftDurationHours(code));
      }
    }
  }

  const issues = validateWeeklyPlan(allUnfilled, employees, daysOrder, config);
  const configurationIssues = [
    ...collectConfigurationIssues(requirements),
    // A structurally-infeasible FIXED weekly pattern (no per-day shift
    // choice left to make, so generation itself can never resolve it) is
    // a workforce-design/capacity gap, not a per-week Plan Warning — see
    // auditStaticShiftHoursFeasibility's doc comment in validation.ts.
    ...auditStaticShiftHoursFeasibility(employees, isFlexibleGeneralPool, config),
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
