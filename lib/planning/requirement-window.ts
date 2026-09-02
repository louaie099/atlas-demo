import { Flight, StaffingRequirement } from "../types";

function subtractMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m - minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * The operational time window a staffing requirement actually needs
 * coverage for. Uses the flight's real boarding window when it has one;
 * otherwise approximates as 45–15 minutes before departure (the same
 * approximation already used by /api/candidates for Check-in-style
 * requirements — centralized here so both share one implementation
 * instead of two copies drifting apart).
 */
export function getRequirementWindow(requirement: StaffingRequirement, flight: Flight): { start: string; end: string } {
  if (flight.boarding_window_start && flight.boarding_window_end) {
    return { start: flight.boarding_window_start, end: flight.boarding_window_end };
  }
  return {
    start: subtractMinutes(flight.scheduled_departure, 45),
    end: subtractMinutes(flight.scheduled_departure, 15),
  };
}
