import { Flight, StaffingRequirement } from "../types";
import { getRamRoleCounts, getRamMesureHeadcount } from "../ram-staffing-matrix";

/**
 * Profiling and Mesure staffing, read from the same shared RAM matrix
 * (lib/ram-staffing-matrix.ts) that drives Gate/Boarding — the "same
 * flight → same rule everywhere" guarantee holds because there's one
 * table, not two.
 *
 * Profiling is aircraft-class-driven, same as Gate/Boarding — it reads
 * getRamRoleCounts. Mesure is destination-driven ONLY — it reads the
 * separate getRamMesureHeadcount, which deliberately ignores aircraft
 * class entirely (see ram-staffing-matrix.ts). Never apply the Dreamliner
 * doubling that legitimately applies to Gate/Boarding/Profiling to Mesure.
 *
 * Both are kept as genuinely separate qualifications/functions — a
 * Profiling requirement and a Mesure requirement never merge into one row
 * even when both apply to the same flight.
 */

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
 * Whether Mesure applies to this RAM flight, and if so, the confirmed
 * headcount. Mesure is CONFIRMED at 4 agents per flight wherever it
 * applies (currently: Canada, UK, USA), regardless of aircraft class — a
 * standard 737-type and a Dreamliner to the same destination category both
 * require exactly 4, never 8. Returns null when there's no established
 * rule at all for this destination category, or when the established rule
 * says Mesure doesn't apply to this category.
 */
export function classifyMesureRequirement(flight: Flight): Omit<StaffingRequirement, "id" | "flight_id"> | null {
  if (flight.operator_type !== "atlas_managed") return null;
  const headcount = getRamMesureHeadcount(flight.destination_category);
  if (headcount === null) return null;

  return {
    role: "Mesure",
    baseline_requirement: headcount,
    additional_requirement: 0,
    total_requirement: headcount,
    source: "fixed_rule",
    reasoning: `${headcount} Mesure agent(s) required — confirmed destination-driven rule for ${flight.destination_category} destinations. Mesure headcount does not scale with aircraft class (unlike Gate/Boarding/Profiling).`,
    needs_configuration: false,
  };
}
