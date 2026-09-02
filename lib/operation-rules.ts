import { Flight, StaffingRequirement } from "./types";

/**
 * RAM (Atlas-managed) Boarding staffing rule table. Baseline headcount is
 * driven by aircraft type + destination category — never by booking
 * pressure (that's demand-forecast.ts's job, and it only ever applies to
 * Check-in/ACE per the existing architectural constraint).
 *
 * This table is intentionally explicit and small. A flight whose
 * (aircraft, destinationCategory) pair isn't listed here returns null —
 * the caller must surface that as "needs configuration", never guess.
 *
 * IMPORTANT — this is illustrative demo data, not a confirmed real RAM
 * Handling staffing matrix. The specific aircraft/destination/headcount
 * combinations below (including which combinations are deliberately
 * absent, e.g. Africa routes) are examples chosen to demonstrate the
 * mechanism, not real operational rules. Replace with the actual RAM
 * staffing matrix before treating any of this as production fact.
 */
const RAM_BOARDING_RULES: Record<string, Record<string, number>> = {
  "Boeing 737-800": {
    "Europe/Schengen": 3,
    Domestic: 2,
  },
  "Boeing 787-9": {
    "Long-haul": 4,
  },
};

export function classifyRamBoardingRequirement(
  flight: Flight
): Omit<StaffingRequirement, "id" | "flight_id"> | null {
  if (!flight.destination_category) return null;

  const baseline = RAM_BOARDING_RULES[flight.aircraft]?.[flight.destination_category];
  if (baseline === undefined) return null;

  return {
    role: "Boarding",
    baseline_requirement: baseline,
    additional_requirement: 0,
    total_requirement: baseline,
    source: "fixed_rule",
    reasoning: `${baseline} Boarding agents required — operation rule for ${flight.aircraft} to ${flight.destination_category} destinations.`,
    needs_configuration: false,
  };
}

/**
 * Returned when a RAM flight's (aircraft, destination category) combination
 * has no configured operation rule. Never fabricates a number.
 */
export function missingOperationRuleRequirement(
  flight: Flight
): Omit<StaffingRequirement, "id" | "flight_id"> {
  return {
    role: "Boarding",
    baseline_requirement: 0,
    additional_requirement: 0,
    total_requirement: 0,
    source: "fixed_rule",
    reasoning: `No operation rule configured for ${flight.aircraft} to "${flight.destination_category ?? "unspecified"}" destinations. Add this combination to the operation rule table before this flight can be planned.`,
    needs_configuration: true,
  };
}
