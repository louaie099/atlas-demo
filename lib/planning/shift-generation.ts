import { Employee } from "../types";
import { DailyDemand, peakDemandForRole, demandWindowForRole } from "./demand-aggregation";
import { selectCompatibleShiftCode } from "../foreign-shift-planning";
import { isFlexibleGeneralPool } from "./workforce-pools";
import { getShiftTimesAs } from "../shift-templates";
import { restHoursBetween } from "../roster-generation";

/** An employee's effective shift on the immediately preceding day, or null if they were OFF/unrostered — undefined (not in the map) means "no prior-day data available" (e.g. the first day of the week), which is never treated as a rest violation. */
export type PriorDayShiftMap = Map<string, { shift_start: string; shift_end: string } | null>;

export interface GeneratedShiftAssignment {
  employeeId: string;
  dayOfWeek: string;
  shiftCode: string;
  coversRoles: string[]; // which roles this employee's shift was assigned to help cover
}

/**
 * Stage 6 of the planning pipeline: assigning daily shifts to the
 * flexible General T1 ACE pool, driven by the day's aggregated demand
 * (Stage 5) rather than flight-by-flight.
 *
 * This is a deliberate FIRST-PASS GREEDY HEURISTIC, not an optimizer:
 *  - Roles are processed in a fixed order (Boarding, Check-in, Gate,
 *    Profiling, Mesure) — Profiling/Mesure demand is now real (see
 *    specialized-demand.ts), and this is what lets a General T1 employee
 *    who happens to hold the Profiling/Mesure skill flex into covering it,
 *    per the brief ("cross-qualified employees can provide additional
 *    flexibility"). Employees whose PLACEMENT is Profiling/Mesure are
 *    never in this pool at all (see workforce-pools.ts) — this is only
 *    about General T1 employees with a matching skill.
 *  - Before pulling in a new employee for a role, it first checks whether
 *    employees ALREADY assigned a shift today (for an earlier-processed
 *    role) are also qualified for this role and their shift covers this
 *    role's demand window — this is what lets one multi-skilled
 *    employee's single shift count toward multiple roles' demand, rather
 *    than needlessly rostering extra people.
 *  - Employees already OFF that day (per weekly_shifts) or not in the
 *    flexible pool are never considered.
 *  - Stops once a role's peak demand is met or there are no more
 *    qualified, available, RESTED employees — it does NOT try to minimize
 *    total headcount or balance fairness across the week. A real optimizer
 *    would need to weigh all of that together; this doesn't claim to.
 *
 * Cross-day rest is now part of shift SELECTION, not just after-the-fact
 * detection: `priorDayShift` carries each employee's effective shift on
 * the immediately preceding day (built by the caller as it walks the week
 * day by day). Before a candidate shift is handed to an employee, it must
 * clear the same minimum-rest rule validation.ts already enforces
 * (`restHoursBetween`, identical definition — see roster-generation.ts).
 * An employee who would land below the minimum is simply skipped for that
 * role/day: this is a real, honest coverage shortfall, surfaced later as
 * an unfilled_duty by Stage 10 if nobody else can cover it — never an
 * illegal roster silently created and only flagged afterward. Causality
 * stays: today's operational demand determines the candidate shift; rest
 * against yesterday's actual shift then filters WHO can take it.
 */
export function generateFlexiblePoolShifts(
  dayOfWeek: string,
  demand: DailyDemand,
  allEmployees: Employee[],
  priorDayShift: PriorDayShiftMap = new Map(),
  minimumRestHours = 0,
  rolesToConsider: string[] = ["Boarding", "Check-in", "Gate", "Profiling", "Mesure"]
): GeneratedShiftAssignment[] {
  const flexiblePool = allEmployees.filter(isFlexibleGeneralPool);

  const isOffThisDay = (e: Employee) => e.weekly_shifts.find((s) => s.day_of_week === dayOfWeek)?.status === "off";
  const availableToday = flexiblePool.filter((e) => !isOffThisDay(e));

  const assignments = new Map<string, GeneratedShiftAssignment>(); // employeeId -> assignment

  for (const role of rolesToConsider) {
    const peak = peakDemandForRole(demand, role);
    if (peak === 0) continue;

    const window = demandWindowForRole(demand, role);
    if (!window) continue;

    const shiftCode = selectCompatibleShiftCode(window.start, window.end);
    if (!shiftCode) continue; // no catalog shift covers this window at all — cannot roster anyone for it, not a fabricated one either
    const { shift_start } = getShiftTimesAs(shiftCode);

    // Count how many already-assigned employees (from an earlier role)
    // are qualified for this role too — their existing shift already
    // covers them, no new assignment needed.
    let covered = Array.from(assignments.values()).filter((a) => {
      const employee = availableToday.find((e) => e.id === a.employeeId);
      return employee?.skills.includes(role);
    }).length;

    if (covered > 0) {
      for (const a of assignments.values()) {
        const employee = availableToday.find((e) => e.id === a.employeeId);
        if (employee?.skills.includes(role) && !a.coversRoles.includes(role)) {
          a.coversRoles.push(role);
        }
      }
    }

    for (const employee of availableToday) {
      if (covered >= peak) break;
      if (assignments.has(employee.id)) continue; // already rostered today for another role, not re-counted here (handled above)
      if (!employee.skills.includes(role)) continue;

      // Never knowingly create a shift-to-shift transition shorter than
      // the minimum rest rule, even though this shift otherwise fully
      // covers today's demand window.
      const priorShift = priorDayShift.get(employee.id);
      if (priorShift && restHoursBetween(priorShift.shift_end, shift_start) < minimumRestHours) {
        continue;
      }

      assignments.set(employee.id, {
        employeeId: employee.id,
        dayOfWeek,
        shiftCode,
        coversRoles: [role],
      });
      covered++;
    }
  }

  return Array.from(assignments.values());
}
