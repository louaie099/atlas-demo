import { Flight, StaffingRequirement } from "./types";
import { getRamRoleCounts } from "./ram-staffing-matrix";

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
      reasoning: `${counts.gate} Gate agent(s) required -- operation rule for ${basis}.`,
      needs_configuration: false,
    },
    {
      role: "Boarding",
      baseline_requirement: counts.boarding,
      additional_requirement: 0,
      total_requirement: counts.boarding,
      source: "fixed_rule",
      reasoning: `${counts.boarding} Boarding agent(s) required -- operation rule for ${basis}.`,
      needs_configuration: false,
    },
  ];
}

export function missingOperationRuleRequirement(
  flight: Flight
): Omit<StaffingRequirement, "id" | "flight_id"> {
  const reasoning = flight.destination_category
    ? `No operation rule configured for ${flight.aircraft} to "${flight.destination_category}" destinations (${flight.destination}). Add this combination to the RAM staffing matrix (lib/ram-staffing-matrix.ts) before this flight can be planned.`
    : `"${flight.destination}" could not be confidently classified into an established RAM operational category (see lib/destination-classification.ts). This is a classification gap, not a staffing-matrix gap -- add a confirmed country/category mapping before this flight can be planned.`;

  return {
    role: "Boarding",
    baseline_requirement: 0,
    additional_requirement: 0,
    total_requirement: 0,
    source: "fixed_rule",
    reasoning,
    needs_configuration: true,
  };
}
