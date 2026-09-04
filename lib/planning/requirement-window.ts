import { Flight, StaffingRequirement } from "../types";
import { isDreamlinerAircraft } from "../ram-staffing-matrix";

function subtractMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m - minutes;
  const wrapped = ((total % 1440) + 1440) % 1440;
  const hh = Math.floor(wrapped / 60);
  const mm = wrapped % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * The established RAM requirement timing rule: an Embraer/737-type
 * operation's staffing requirement starts approximately T-1h before
 * departure; a Dreamliner's starts T-1h30. Kept as a small, named lookup
 * — rather than inlined numbers — so a real per-aircraft-type table can
 * replace this later without touching the caller below.
 */
const RAM_REQUIREMENT_LEAD_MINUTES = {
  standard: 60, // T-1h
  dreamliner: 90, // T-1h30
};

/** Gate, Boarding, Profiling, and (once configured) Mesure — the RAM operation-rule roles this timing rule governs. */
const RAM_OPERATION_ROLES = new Set(["Gate", "Boarding", "Profiling", "Mesure"]);

/**
 * The operational time window a staffing requirement actually needs
 * coverage for.
 *
 * For a RAM (fixed_rule, Gate/Boarding/Profiling/Mesure) requirement, this
 * is now the established rule: starts T-1h (standard aircraft) or T-1h30
 * (Dreamliner) before scheduled/updated departure, and runs until that
 * departure — for the prototype, no separate end offset. Gate, Boarding
 * and Profiling deliberately share the SAME window and are never
 * serialized with arbitrary buffers between them; they're genuinely
 * concurrent operations, per the brief. This replaces any explicit
 * boarding_window_start/end the flight record might carry for these
 * roles — those fields predate this rule and are no longer authoritative
 * for RAM timing (they're still shown as-is elsewhere, e.g. flight
 * displays, just not used here).
 *
 * For every other requirement (Check-in/demand_forecast, foreign-company
 * company_config), the previous approximation still applies unchanged:
 * the flight's real boarding window when set, otherwise 45-15 minutes
 * before departure — centralized here so every caller shares one
 * implementation instead of drifting copies.
 */
export function getRequirementWindow(requirement: StaffingRequirement, flight: Flight): { start: string; end: string } {
  if (requirement.source === "fixed_rule" && RAM_OPERATION_ROLES.has(requirement.role)) {
    const leadMinutes = isDreamlinerAircraft(flight.aircraft)
      ? RAM_REQUIREMENT_LEAD_MINUTES.dreamliner
      : RAM_REQUIREMENT_LEAD_MINUTES.standard;
    return { start: subtractMinutes(flight.scheduled_departure, leadMinutes), end: flight.scheduled_departure };
  }

  if (flight.boarding_window_start && flight.boarding_window_end) {
    return { start: flight.boarding_window_start, end: flight.boarding_window_end };
  }
  return {
    start: subtractMinutes(flight.scheduled_departure, 45),
    end: subtractMinutes(flight.scheduled_departure, 15),
  };
}
