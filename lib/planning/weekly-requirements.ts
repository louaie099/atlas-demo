import { Flight, StaffingRequirement, Config } from "../types";
import { computeCheckinRequirement } from "../demand-forecast";
import { classifyRamBoardingRequirement, missingOperationRuleRequirement } from "../operation-rules";
import { classifyCompanyRequirement, missingCompanyConfigRequirement } from "../company-config";

/**
 * Classifies a single flight into its staffing requirement, using the
 * same rule modules everywhere in the app — never a special case here.
 * This was previously duplicated logic living inside reset-database.ts;
 * extracted here so seeding and the planning pipeline share exactly one
 * implementation, per the "no parallel representations" instruction.
 *
 * RAM/atlas_managed flights go through operation-rules.ts (Boarding) or
 * demand-forecast.ts (Check-in — AT535 is the one demand-forecast case in
 * the seed data by design). Self-managed (foreign carrier) flights go
 * through company-config.ts. A flight with no matching rule/config comes
 * back with needs_configuration: true — never a guessed number.
 */
export function classifyFlightRequirement(flight: Flight, config: Config): Omit<StaffingRequirement, "id" | "flight_id"> {
  if (flight.operator_type === "self_managed") {
    return classifyCompanyRequirement(flight) ?? missingCompanyConfigRequirement(flight);
  }

  if (flight.id === "at535") {
    return computeCheckinRequirement(flight, config);
  }

  return classifyRamBoardingRequirement(flight) ?? missingOperationRuleRequirement(flight);
}

/**
 * Computes staffing requirements for every flight in the given set — the
 * first pipeline stage ("Weekly flight schedule → RAM staffing
 * requirements → total demand"). One requirement per flight, with a
 * deterministic id matching the existing seed convention
 * (req-<flightId>-<role>) so this is a drop-in replacement for the
 * per-flight logic already used at seed time, not a parallel one.
 */
export function computeWeeklyStaffingRequirements(flights: Flight[], config: Config): StaffingRequirement[] {
  return flights.map((flight) => {
    const classified = classifyFlightRequirement(flight, config);
    const id = `req-${flight.id}-${classified.role.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return { id, flight_id: flight.id, ...classified };
  });
}
