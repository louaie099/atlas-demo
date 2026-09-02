import { Employee } from "../types";
import { DailyDemand, peakDemandForRole, demandWindowForRole } from "./demand-aggregation";
import { selectCompatibleShiftCode } from "../foreign-shift-planning";
import { isFlexibleGeneralPool } from "./workforce-pools";

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
 *  - Roles are processed in a fixed order (Boarding, Check-in, Gate).
 *  - Before pulling in a new employee for a role, it first checks whether
 *    employees ALREADY assigned a shift today (for an earlier-processed
 *    role) are also qualified for this role and their shift covers this
 *    role's demand window — this is what lets one multi-skilled
 *    employee's single shift count toward multiple roles' demand, rather
 *    than needlessly rostering extra people.
 *  - Employees already OFF that day (per weekly_shifts) or not in the
 *    flexible pool are never considered.
 *  - Stops once a role's peak demand is met or there are no more
 *    qualified, available employees — it does NOT try to minimize total
 *    headcount, balance fairness across the week, or consider anything
 *    beyond this single day in isolation. A real optimizer would need to
 *    weigh all of that together; this doesn't claim to.
 */
export function generateFlexiblePoolShifts(
  dayOfWeek: string,
  demand: DailyDemand,
  allEmployees: Employee[],
  rolesToConsider: string[] = ["Boarding", "Check-in", "Gate"]
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

      const shiftCode = selectCompatibleShiftCode(window.start, window.end);
      if (!shiftCode) continue; // no catalog shift covers this window — cannot roster anyone for it, not a fabricated one either

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
