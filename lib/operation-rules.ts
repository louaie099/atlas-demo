import { Flight, StaffingRequirement } from "./types";
import { getRamRoleCounts } from "./ram-staffing-matrix";

/**
 * RAM (Atlas-managed) Gate + Boarding staffing rules — reads the shared
 * matrix (lib/ram-staffing-matrix.ts) rather than keeping its own copy of
 * the numbers. Gate and Boarding are always generated together as two
 * DISTINCT concurrent requirements (never one merged headcount) whenever
 * the flight's (destination category, aircraft class) combination is
 * established. A flight whose combination isn't in the matrix returns
 * null — the caller must surface that as "needs configuration", never
 * guess.
 */
export function classifyRamGateAndBoardingRequirements(
  flight: Flight
): Omit<StaffingRequirement, "id" | "flight_id">[] | null {
  if (!flight.destination_category) return null;

  const counts = getRamRoleCounts(flight.destination_category, flight.aircraft);
  if (!counts) return null;

  const basis = `${flight.aircraft} to ${flight.destination_category} destinations`;

  return [
    {
      role: "Gate",
      baseline_requirement: counts.gate,
      additional_requirement: 0,
      total_requirement: counts.gate,
      source: "fixed_rule",
      reasoning: `${counts.gate} Gate agent(s) required — operation rule for ${basis}.`,
      needs_configuration: false,
    },
    {
      role: "Boarding",
      baseline_requirement: counts.boarding,
      additional_requirement: 0,
      total_requirement: counts.boarding,
      source: "fixed_rule",
      reasoning: `${counts.boarding} Boarding agent(s) required — operation rule for ${basis}.`,
      needs_configuration: false,
    },
  ];
}

/**
 * Returned when a RAM flight's (aircraft, destination category) combination
 * has no configured operation rule at all — represents the whole flight's
 * RAM staffing as a single unconfigured placeholder, rather than one
 * fabricated row per role. Never fabricates a number.
 *
 * The role field is deliberately NOT "Boarding" (or any real staffing
 * role) — this row does not claim ATLAS knows Boarding is what's missing;
 * it claims ATLAS knows NOTHING is configured yet for this flight. Using a
 * real role name here would misrepresent a flight/configuration problem as
 * a staffing shortfall for one specific role, which the requirement/
 * coverage pipeline (and any future UI reading `role`) would otherwise
 * have no way to distinguish from a genuine Boarding gap.
 *
 * Two distinct causes, kept honestly separate via both `role` and
 * `reasoning`:
 *  - "Destination Classification": the destination itself could not be
 *    confidently classified into any established RAM operational category
 *    at all (e.g. Turkey, Canada — see lib/destination-classification.ts).
 *    This is a classification gap, one level before staffing.
 *  - "Staffing Rule": the destination HAS a known, confident
 *    classification (e.g. Domestic) but no matrix rule exists yet for
 *    that (aircraft, category) combination — a real, documented staffing
 *    gap, distinct from an unclassified destination.
 */
export function missingOperationRuleRequirement(
  flight: Flight
): Omit<StaffingRequirement, "id" | "flight_id"> {
  const role = flight.destination_category ? "Staffing Rule" : "Destination Classification";
  const reasoning = flight.destination_category
    ? `No operation rule configured for ${flight.aircraft} to "${flight.destination_category}" destinations (${flight.destination}). Add this combination to the RAM staffing matrix (lib/ram-staffing-matrix.ts) before this flight can be planned.`
    : `"${flight.destination}" could not be confidently classified into an established RAM operational category (see lib/destination-classification.ts). This is a classification gap, not a staffing-matrix gap — add a confirmed country/category mapping before this flight can be planned.`;

  return {
    role,
    baseline_requirement: 0,
    additional_requirement: 0,
    total_requirement: 0,
    source: "fixed_rule",
    reasoning,
    needs_configuration: true,
  };
}
