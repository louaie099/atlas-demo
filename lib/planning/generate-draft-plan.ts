import { Employee, Flight, Assignment, Config, StaffingRequirement } from "../types";
import { computeWeeklyStaffingRequirements } from "./weekly-requirements";
import { aggregateDailyDemand } from "./demand-aggregation";
import { generateFlexiblePoolShifts, GeneratedShiftAssignment } from "./shift-generation";
import { generateDutiesForDay, GeneratedDuty } from "./duty-generation";
import { validateWeeklyPlan, PlanIssue } from "./validation";

export interface DraftWeeklyPlan {
  weekLabel: string;
  daysOrder: string[];
  requirements: StaffingRequirement[];
  generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>;
  dutiesByDay: Record<string, GeneratedDuty[]>;
  issues: PlanIssue[];
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
 *  6.   Flexible-pool shift generation, per day, from that day's demand.
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

  for (const day of daysOrder) {
    const demand = aggregateDailyDemand(day, flights, requirements);
    const generatedShifts = generateFlexiblePoolShifts(day, demand, employees);
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
  }

  const issues = validateWeeklyPlan(requirements, allUnfilled, employees, daysOrder, config);

  return {
    weekLabel,
    daysOrder,
    requirements,
    generatedShiftsByDay,
    dutiesByDay,
    issues,
    generatedAt: new Date().toISOString(),
  };
}
