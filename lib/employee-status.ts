import { Employee, Assignment, StaffingRequirement, Flight } from "./types";
import { isFixedPlanningTeam, isTransitTeam } from "./teams";
import { computeForeignCompanyProtectedWindow } from "./foreign-company-window";

export type EmployeeDayStatus = "off" | "not_rostered" | "committed" | "transit" | "on_duty";

export interface DayDuty {
  flightNumber: string;
  role: string;
  scheduledDeparture: string;
  airline: string;
}

export interface EmployeeDaySummary {
  dayOfWeek: string;
  shiftCode: string | null;
  status: EmployeeDayStatus;
  duties: DayDuty[];
  foreignCommitment: { airline: string; window: { start: string; end: string } } | null;
}

/**
 * Computes what an employee is doing on a specific day, from real
 * assignment data — never a guess. Status precedence: "not_rostered"
 * (no roster entry exists for this day at all — a freshly-created
 * employee with no plan yet) is distinct from "off" (a real roster entry
 * that explicitly says don't work that day) — conflating the two would
 * repeat exactly the kind of concept-blur this project has been
 * correcting all along. Beyond that: OFF beats everything else; a
 * foreign-company commitment (backed by a real Assignment to a
 * company_config requirement on that day) beats Transit; Transit
 * assignment beats plain "on duty".
 *
 * "committed" reflects that the employee HAS a foreign assignment that
 * day — it does not claim they are inside the protected window at this
 * exact moment (this demo has no live clock; see foreign-company-window.ts
 * for the window itself, shown as informational).
 *
 * `realRosterEntry` (2026-10-27, "Not Rostered after regenerate" fix):
 * when the caller has a real, persisted Weekly Planning roster entry for
 * this employee+day (from weekly_plan_roster_entries, via
 * loadPersistedPlanView — the same durable source Agent Schedule and
 * every generation stage already treat as authoritative), it is used
 * INSTEAD of employee.weekly_shifts. employee.weekly_shifts is a
 * pre-Weekly-Planning legacy column (see migration 0005's own doc
 * comment): it is populated once, uniformly, only by the seed script, and
 * real roster generation has never written back to it — confirmed via a
 * live repro where a bulk-imported employee kept showing "Not Rostered"
 * on the Employees page no matter how many times Generate/Regenerate
 * Planning ran, because regeneration persists into
 * weekly_plan_roster_entries, a table this function's caller never used
 * to even look at. Every pre-existing employee (seeded with a real
 * weekly_shifts baseline) is unaffected when a real roster entry is
 * supplied, since the persisted plan's own entry for them agrees with
 * their seed data; omitting this parameter reproduces the exact prior
 * (weekly_shifts-only) behavior, so every existing caller/test is
 * untouched.
 */
export function computeEmployeeDaySummary(
  employee: Employee,
  dayOfWeek: string,
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  realRosterEntry?: { shift_code: string | null; status: "working" | "off" }
): EmployeeDaySummary {
  const shiftEntry = realRosterEntry
    ? { day_of_week: dayOfWeek, shift_code: realRosterEntry.shift_code, status: realRosterEntry.status }
    : employee.weekly_shifts.find((s) => s.day_of_week === dayOfWeek);

  if (!shiftEntry) {
    return { dayOfWeek, shiftCode: null, status: "not_rostered", duties: [], foreignCommitment: null };
  }

  const shiftCode = shiftEntry.shift_code ?? null;

  if (shiftEntry.status === "off") {
    return { dayOfWeek, shiftCode: null, status: "off", duties: [], foreignCommitment: null };
  }

  const myAssignments = assignments.filter((a) => a.employee_id === employee.id);
  const duties: DayDuty[] = [];
  let foreignCommitment: EmployeeDaySummary["foreignCommitment"] = null;

  for (const a of myAssignments) {
    const requirement = requirements.find((r) => r.id === a.staffing_requirement_id);
    if (!requirement) continue;
    const flight = flights.find((f) => f.id === requirement.flight_id);
    if (!flight || flight.day_of_week !== dayOfWeek) continue;

    duties.push({
      flightNumber: flight.flight_number,
      role: requirement.role,
      scheduledDeparture: flight.scheduled_departure,
      airline: flight.airline,
    });

    if (requirement.source === "company_config") {
      foreignCommitment = { airline: flight.airline, window: computeForeignCompanyProtectedWindow(flight) };
    }
  }

  duties.sort((a, b) => a.scheduledDeparture.localeCompare(b.scheduledDeparture));

  let status: EmployeeDayStatus = "on_duty";
  if (foreignCommitment) status = "committed";
  else if (isTransitTeam(employee.assignment)) status = "transit";

  return { dayOfWeek, shiftCode, status, duties, foreignCommitment };
}

/**
 * Fixed-planning employees (Leaders, Duty Officers, Caisse/BCB) are always
 * on duty in their specialized capacity when not OFF — they're never
 * "unavailable", just outside general allocation. Exposed separately so
 * the UI can label them distinctly without conflating this with the
 * on_duty/committed/transit states above, which describe availability for
 * general staffing.
 */
export function isFixedPlanningAssignment(assignment: string): boolean {
  return isFixedPlanningTeam(assignment);
}
