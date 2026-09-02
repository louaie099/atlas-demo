import { Flight, Assignment, StaffingRequirement } from "./types";

/**
 * Foreign-company ACEs remain RAM Handling employees. Their foreign-company
 * assignment is a time-bounded commitment, not permanent unavailability:
 * roughly 4h30 before the foreign flight's departure, they move to
 * Terminal 2 for that carrier; once the flight departs, they're available
 * to RAM again if their RAM Handling shift is still active.
 *
 * This is a generic function over any self-managed flight — never
 * hardcoded to one airline.
 */
const PROTECTED_WINDOW_MINUTES_BEFORE_DEPARTURE = 4 * 60 + 30; // 4h30

export function computeForeignCompanyProtectedWindow(
  flight: Flight
): { start: string; end: string } {
  const [h, m] = flight.scheduled_departure.split(":").map(Number);
  const departureMinutes = h * 60 + m;
  const startMinutes = ((departureMinutes - PROTECTED_WINDOW_MINUTES_BEFORE_DEPARTURE) % 1440 + 1440) % 1440;

  const toHHMM = (mins: number) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

  return { start: toHHMM(startMinutes), end: flight.scheduled_departure };
}

export interface ForeignCommitment {
  flightId: string;
  flightNumber: string;
  airline: string;
  dayOfWeek: string;
  window: { start: string; end: string };
}

/**
 * This is where "foreign-company authorization consumes capacity only
 * during the relevant window" actually becomes checkable against real
 * data: an employee's foreign commitments are exactly their Assignments
 * to company_config-sourced StaffingRequirements, each converted into a
 * concrete protected window via the function above. No new "commitment"
 * table is needed — Assignment already represents it; this just makes
 * that representation usable.
 *
 * Not wired into scoring.ts yet — that requires scoring to become
 * day/time-aware, which is explicitly future Weekly Planning engine work,
 * not this step. This function makes the data reachable and testable now.
 */
export function getEmployeeForeignCommitments(
  employeeId: string,
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[]
): ForeignCommitment[] {
  const myRequirementIds = assignments
    .filter((a) => a.employee_id === employeeId)
    .map((a) => a.staffing_requirement_id);

  const commitments: ForeignCommitment[] = [];
  for (const reqId of myRequirementIds) {
    const requirement = requirements.find((r) => r.id === reqId);
    if (!requirement || requirement.source !== "company_config") continue;

    const flight = flights.find((f) => f.id === requirement.flight_id);
    if (!flight) continue;

    commitments.push({
      flightId: flight.id,
      flightNumber: flight.flight_number,
      airline: flight.airline,
      dayOfWeek: flight.day_of_week,
      window: computeForeignCompanyProtectedWindow(flight),
    });
  }

  return commitments;
}
