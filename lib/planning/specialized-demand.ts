import { Flight, StaffingRequirement } from "../types";
import { getRamRoleCounts } from "../ram-staffing-matrix";

/**
 * Profiling and Mesure staffing, read from the same shared RAM matrix
 * (lib/ram-staffing-matrix.ts) that drives Gate/Boarding — the "same
 * flight → same rule everywhere" guarantee holds because there's one
 * table, not two.
 *
 * Three distinct outcomes, kept honestly separate:
 *  - Profiling/Mesure doesn't apply to this flight's destination category
 *    at all (e.g. Profiling for an Africa flight) → return null. Not a
 *    gap, just not relevant — never surfaced as needs_configuration.
 *  - Applies, with a confirmed headcount (Profiling for Europe/UK-USA) →
 *    a real requirement row, needs_configuration: false.
 *  - Applies, but the headcount itself is unconfirmed (Mesure, always,
 *    per the explicit instruction not to invent one) → a real
 *    requirement row with total_requirement 0 and needs_configuration:
 *    true, so it shows up honestly rather than vanishing or being guessed.
 */
function missingSpecializedConfig(
  flight: Flight,
  role: "Profiling" | "Mesure"
): Omit<StaffingRequirement, "id" | "flight_id"> {
  return {
    role,
    baseline_requirement: 0,
    additional_requirement: 0,
    total_requirement: 0,
    source: "fixed_rule",
    reasoning: `${role} applies to ${flight.aircraft} to ${flight.destination_category} destinations, but the required headcount has not been confirmed yet. Add it to the RAM staffing matrix (lib/ram-staffing-matrix.ts) before ${role} can be planned for this flight.`,
    needs_configuration: true,
  };
}

/**
 * Whether this RAM flight has a Profiling requirement, and if so, how
 * many. Returns null when either (a) there's no established rule at all
 * for this destination category/aircraft combination — that's
 * classifyRamGateAndBoardingRequirements/missingOperationRuleRequirement's
 * problem, not duplicated here — or (b) the rule IS established and says
 * Profiling simply doesn't apply to this category (e.g. Africa).
 */
export function classifyProfilingRequirement(flight: Flight): Omit<StaffingRequirement, "id" | "flight_id"> | null {
  if (flight.operator_type !== "atlas_managed") return null;
  const counts = getRamRoleCounts(flight.destination_category, flight.aircraft);
  if (!counts) return null; // no established rule for this combination at all
  if (counts.profiling === null) return null; // established rule says Profiling doesn't apply here

  return {
    role: "Profiling",
    baseline_requirement: counts.profiling,
    additional_requirement: 0,
    total_requirement: counts.profiling,
    source: "fixed_rule",
    reasoning: `${counts.profiling} Profiling agent(s) required — operation rule for ${flight.aircraft} to ${flight.destination_category} destinations.`,
    needs_configuration: false,
  };
}

/**
 * Whether Mesure applies to this RAM flight. Returns null when there's no
 * established rule at all, or when the established rule says Mesure
 * doesn't apply to this category. When it DOES apply (currently: UK/USA
 * only), always returns the unconfigured placeholder — the headcount has
 * never been confirmed, for any category, and this module must not
 * invent one.
 */
export function classifyMesureRequirement(flight: Flight): Omit<StaffingRequirement, "id" | "flight_id"> | null {
  if (flight.operator_type !== "atlas_managed") return null;
  const counts = getRamRoleCounts(flight.destination_category, flight.aircraft);
  if (!counts) return null;
  if (!counts.mesureApplicable) return null;

  return missingSpecializedConfig(flight, "Mesure");
}
