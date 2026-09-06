import { Employee, Flight, StaffingRequirement } from "./types";
import { SHIFT_CODES } from "./shift-templates";
import { computeForeignCompanyProtectedWindow } from "./foreign-company-window";
import { restHoursBetween } from "./roster-generation";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * Selects the RAM Handling shift code that covers a given protected
 * window, from the authoritative shift catalog — never a hardcoded
 * per-company mapping. A shift is compatible only if it starts at or
 * before the window start AND ends at or after the window end (i.e. the
 * shift fully contains the company's operational window).
 *
 * Among compatible shifts, prefers (1) the smallest gap between shift
 * start and window start (closest fit, least wasted early time), then
 * (2) the shortest total shift duration (don't roster someone longer than
 * necessary). This is what makes "Gulf Air at 09:00 → MT02" fall out of
 * the general rule rather than being a special case for Gulf Air.
 *
 * Deliberately does not handle shifts or windows that cross midnight —
 * a documented limitation for overnight company flights, not silently
 * guessed. Returns null (never a fabricated shift) if no catalog code is
 * compatible.
 *
 * Optional cross-day rest awareness: when `adjacentShiftEnd` (the end
 * time of the employee's actual shift on the immediately preceding
 * calendar day) and `minimumRestHours` are both given, a candidate is
 * only eligible if it also leaves at least that much rest since that
 * prior shift — evaluated with the exact same rest definition used
 * everywhere else (`restHoursBetween`, lib/roster-generation.ts). Ranking
 * among the REMAINING eligible candidates is unchanged (closest fit, then
 * shortest duration) — this never relaxes the rest rule to get a
 * "better" fit; it only ever narrows the candidate pool. Returns null —
 * never a shift that knowingly breaks rest — if no candidate qualifies.
 */
export function selectCompatibleShiftCode(
  windowStart: string,
  windowEnd: string,
  adjacentShiftEnd?: string | null,
  minimumRestHours?: number
): string | null {
  const windowStartMin = timeToMinutes(windowStart);
  const windowEndMin = timeToMinutes(windowEnd);

  let candidates = Object.entries(SHIFT_CODES)
    .map(([code, { entree, sortie }]) => ({
      code,
      entreeMin: timeToMinutes(entree),
      sortieMin: timeToMinutes(sortie),
    }))
    .filter((c) => c.sortieMin > c.entreeMin) // exclude overnight-wrapping codes from this matcher
    .filter((c) => c.entreeMin <= windowStartMin && c.sortieMin >= windowEndMin);

  if (adjacentShiftEnd != null && minimumRestHours != null) {
    candidates = candidates.filter(
      (c) => restHoursBetween(adjacentShiftEnd, minutesToTime(c.entreeMin)) >= minimumRestHours
    );
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const gapA = windowStartMin - a.entreeMin;
    const gapB = windowStartMin - b.entreeMin;
    if (gapA !== gapB) return gapA - gapB;
    const durationA = a.sortieMin - a.entreeMin;
    const durationB = b.sortieMin - b.entreeMin;
    return durationA - durationB;
  });

  return candidates[0].code;
}

/**
 * Finds EVERY flight a given company operates on a given day — never
 * assumes at most one. Returns an empty array (never a fabricated flight)
 * if that company has no flight that day.
 */
export function findCompanyFlightsOnDay(company: string, dayOfWeek: string, flights: Flight[]): Flight[] {
  return flights.filter((f) => f.airline === company && f.day_of_week === dayOfWeek);
}

export interface FlightWindow {
  flight: Flight;
  window: { start: string; end: string };
}

export interface ForeignDayPlan {
  flights: Flight[]; // every company flight that day (always >= 1 when this is non-null)
  windows: FlightWindow[]; // each flight's own individual protected window
  combinedWindow: { start: string; end: string }; // union span, used only for shift selection
  shiftCode: string | null;
}

/**
 * The core rule this module exists for: company flight schedule drives
 * the roster, not the other way around. Given a company and a day, if
 * that company has one or more flights that day, this computes each
 * flight's own protected window (kept separate, for precise per-flight
 * overlap checks elsewhere), the combined span across all of them (used
 * only to pick one RAM shift that covers the whole day's company
 * operation), and the compatible shift for that combined span.
 *
 * Returns null — never a fake plan — if there's no flight that day.
 *
 * `adjacentShiftEnd`/`minimumRestHours` (optional): same cross-day rest
 * awareness as selectCompatibleShiftCode, threaded through so a caller
 * building a sequential weekly roster (see seed-data.ts's
 * applyForeignCompanyRoster) can pick a shift that both covers the
 * protected window AND respects the employee's rest since their previous
 * day — never one that only satisfies coverage.
 */
export function planForeignCompanyDay(
  company: string,
  dayOfWeek: string,
  flights: Flight[],
  adjacentShiftEnd?: string | null,
  minimumRestHours?: number
): ForeignDayPlan | null {
  const dayFlights = findCompanyFlightsOnDay(company, dayOfWeek, flights);
  if (dayFlights.length === 0) return null;

  const windows: FlightWindow[] = dayFlights.map((flight) => ({
    flight,
    window: computeForeignCompanyProtectedWindow(flight),
  }));

  const combinedStartMin = Math.min(...windows.map((w) => timeToMinutes(w.window.start)));
  const combinedEndMin = Math.max(...windows.map((w) => timeToMinutes(w.window.end)));
  const combinedWindow = { start: minutesToTime(combinedStartMin), end: minutesToTime(combinedEndMin) };

  const shiftCode = selectCompatibleShiftCode(combinedWindow.start, combinedWindow.end, adjacentShiftEnd, minimumRestHours);

  return { flights: dayFlights, windows, combinedWindow, shiftCode };
}

export interface ForeignCommitmentAssignment {
  id: string;
  staffing_requirement_id: string;
  employee_id: string;
}

/**
 * Builds the real duty Assignment rows for every configured foreign
 * company's flights across the week — enforcing two invariants that a
 * previous version of this logic violated:
 *
 * 1. HEADCOUNT: never more than requirement.total_requirement distinct
 *    employees per (flight, requirement) — company team membership or
 *    authorization is NOT the same as being assigned to a specific
 *    flight. Only the number of employees the requirement actually needs
 *    is selected from the pool of employees genuinely working that day
 *    with a shift covering the flight's protected window; every other
 *    company employee keeps their normal RAM Handling shift that day
 *    without holding a duty on this flight.
 * 2. NO DOUBLE-BOOKING: an employee selected for one of a company's
 *    same-day flights is removed from that day's available pool before
 *    the next same-day flight (if any) is considered, so nobody can be
 *    assigned to two overlapping company flights on one day.
 *
 * Deterministic: employees are selected in the order they appear in
 * `employees` (never randomized), so Reset Demo always reproduces the
 * exact same scenario.
 */
export function buildForeignCommitmentAssignments(
  employees: Employee[],
  flights: Flight[],
  requirements: StaffingRequirement[],
  daysOrder: string[],
  configuredCompanies: string[]
): ForeignCommitmentAssignment[] {
  const foreignAssignmentEmployees = employees.filter((e) => configuredCompanies.includes(e.assignment));
  const assignments: ForeignCommitmentAssignment[] = [];

  for (const day of daysOrder) {
    for (const company of configuredCompanies) {
      const plan = planForeignCompanyDay(company, day, flights);
      if (!plan || !plan.shiftCode) continue; // no flight that day, or no compatible shift — no commitment to record

      let availablePool = foreignAssignmentEmployees.filter((e) => {
        if (e.assignment !== company) return false;
        const dayEntry = e.weekly_shifts.find((s) => s.day_of_week === day);
        return dayEntry?.status !== "off";
      });

      for (const { flight } of plan.windows) {
        const requirement = requirements.find((r) => r.flight_id === flight.id && !r.needs_configuration);
        if (!requirement) continue;

        const selected = availablePool.slice(0, requirement.total_requirement);
        for (const emp of selected) {
          assignments.push({
            id: `assign-foreign-${emp.id}-${flight.id}`,
            staffing_requirement_id: requirement.id,
            employee_id: emp.id,
          });
        }

        const selectedIds = new Set(selected.map((e) => e.id));
        availablePool = availablePool.filter((e) => !selectedIds.has(e.id));
      }
    }
  }

  return assignments;
}
