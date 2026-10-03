/**
 * Flight operational LIFECYCLE phase — a NEW, purely-display, passenger-
 * facing concept for Live Operations, per the product owner's own words:
 * "the live operation should show the current state of flight for example
 * (open for check in: 4hr before departure, checkin closing: 1h before
 * departure, boarding: 45min before departure, boarding closing: 15min
 * before departure, departed: after departure time passes)". These
 * thresholds are the product owner's own specified values for THIS
 * feature only.
 *
 * This is deliberately independent of the two other, already-established
 * timing models elsewhere in lib/planning, which this file must never be
 * confused with or made to influence:
 *  - lib/planning/checkin-demand.ts's DEFAULT_CHECKIN_DEMAND_POLICY, which
 *    drives real Check-in STAFFING HEADCOUNT math (an unconfirmed
 *    prototype policy, explicitly marked as such).
 *  - lib/planning/requirement-window.ts's RAM Gate/Boarding/Profiling
 *    staffing window (a confirmed real rule, T-1h/T-1h30 before
 *    departure).
 * Neither of those is touched by this file, and this file touches
 * neither of them back — this only decides what LABEL and colored LIGHT
 * Live Operations shows for a flight's current real-world lifecycle
 * stage.
 */

export type FlightPhase =
  | "pre_checkin"
  | "checkin_open"
  | "checkin_closed"
  | "boarding"
  | "boarding_closing"
  | "departed";

export const FLIGHT_PHASE_LABEL: Record<FlightPhase, string> = {
  pre_checkin: "Not yet open",
  checkin_open: "Check-in open",
  checkin_closed: "Check-in closed",
  boarding: "Boarding",
  boarding_closing: "Boarding closing — final call",
  departed: "Departed",
};

/**
 * The product owner's own stated thresholds for this feature, in minutes
 * before scheduled/effective departure — NOT an "unconfirmed prototype"
 * placeholder like DEFAULT_CHECKIN_DEMAND_POLICY elsewhere: these are the
 * exact numbers he gave (4h / 1h / 45min / 15min).
 */
export const FLIGHT_PHASE_THRESHOLDS_MINUTES = {
  checkinOpen: 240, // T-4h: check-in opens
  checkinClose: 60, // T-1h: check-in closes
  boardingStart: 45, // T-45min: boarding starts
  boardingClose: 15, // T-15min: boarding closes ("final call")
};

/**
 * "HH:mm" -> minutes since midnight. A small local copy — the only other
 * implementation in lib/ is a non-exported local helper of the same name
 * inside lib/live-ops-service.ts, so this file keeps its own rather than
 * reaching into that module's internals.
 */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Pure derivation of a flight's current lifecycle phase from its
 * effective departure time and "now," both in minutes-since-midnight.
 *
 * Timeline, walking forward from well before departure to after it:
 *   ... > 240min left -> pre_checkin
 *   240min .. 60min left -> checkin_open
 *   60min .. 45min left -> checkin_closed   (checked in closed, boarding not yet)
 *   45min .. 15min left -> boarding
 *   15min .. 0min left -> boarding_closing
 *   <= 0min left (departure time passed) -> departed
 *
 * Boundaries are evaluated going from "departed" backward so each `<=`
 * check claims its own threshold with no overlap and no gap.
 */
export function deriveAutoFlightPhase(effectiveDepartureHHmm: string, nowMinutesSinceMidnight: number): FlightPhase {
  const minutesUntilDeparture = timeToMinutes(effectiveDepartureHHmm) - nowMinutesSinceMidnight;

  if (minutesUntilDeparture <= 0) return "departed";
  if (minutesUntilDeparture <= FLIGHT_PHASE_THRESHOLDS_MINUTES.boardingClose) return "boarding_closing";
  if (minutesUntilDeparture <= FLIGHT_PHASE_THRESHOLDS_MINUTES.boardingStart) return "boarding";
  if (minutesUntilDeparture <= FLIGHT_PHASE_THRESHOLDS_MINUTES.checkinClose) return "checkin_closed";
  if (minutesUntilDeparture <= FLIGHT_PHASE_THRESHOLDS_MINUTES.checkinOpen) return "checkin_open";
  return "pre_checkin";
}

/**
 * Resolves the phase Live Operations should actually show: a DO's manual
 * override (set, non-null) always wins over the auto-derived clock-based
 * phase — e.g. boarding started early, or a departure already happened
 * but the operational time hasn't been updated yet.
 */
export function resolveFlightPhase(
  flight: { operational_phase_override?: FlightPhase | null },
  effectiveDepartureHHmm: string,
  nowMinutesSinceMidnight: number
): { phase: FlightPhase; isManualOverride: boolean } {
  if (flight.operational_phase_override != null) {
    return { phase: flight.operational_phase_override, isManualOverride: true };
  }
  return { phase: deriveAutoFlightPhase(effectiveDepartureHHmm, nowMinutesSinceMidnight), isManualOverride: false };
}
