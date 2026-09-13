import { Flight, StaffingRequirement, Config } from "../types";
import { classifyRamGateAndBoardingRequirements, missingOperationRuleRequirement } from "../operation-rules";
import { classifyProfilingRequirement, classifyMesureRequirement } from "./specialized-demand";
import { classifyCompanyRequirement } from "../company-config";
import { isCheckinApplicable, computeGeneralizedCheckinRequirement } from "./checkin-demand";

/**
 * Classifies a single flight into its staffing requirement(s), using the
 * same rule modules everywhere in the app — never a special case here.
 * This was previously duplicated logic living inside reset-database.ts;
 * extracted here so seeding and the planning pipeline share exactly one
 * implementation, per the "no parallel representations" instruction.
 *
 * A flight can now produce MULTIPLE concurrent requirements — this is the
 * real operational shape (a RAM flight simultaneously needs Gate,
 * Boarding, and often Profiling agents, not one merged headcount).
 *
 * RAM/atlas_managed flights go through operation-rules.ts (Gate +
 * Boarding) plus specialized-demand.ts (Profiling, and Mesure where
 * applicable) plus checkin-demand.ts (Check-in — GENERALIZED to every
 * atlas_managed flight via a configurable/prototype policy, never a
 * single hardcoded flight id; see that file's doc comment for what's
 * confirmed vs prototype). Self-managed (foreign carrier) flights go
 * through company-config.ts instead, and never also get a RAM Check-in
 * row — see isCheckinApplicable.
 *
 * Check-in is intentionally NOT gated on the RAM Gate/Boarding/Profiling
 * matrix having an established rule for this flight's (destination
 * category, aircraft) pair — Check-in demand exists independently of
 * whether that separate security-staffing matrix happens to be
 * configured for this destination, so a flight can have a real Check-in
 * requirement even while its Gate/Boarding is reported as
 * needs_configuration.
 *
 * MANAGED vs SCHEDULED: a flight existing in the weekly schedule does not
 * by itself mean ATLAS generates workforce coverage for it. A self-managed
 * (foreign carrier) flight with no COMPANY_STAFFING_CONFIG entry is a real,
 * scheduled flight that simply has no ATLAS staffing role at all — it
 * returns an EMPTY requirement list, not a placeholder "needs
 * configuration" row. Flight Schedule still shows it; Flight Coverage
 * never does. A RAM/atlas_managed flight with no established operation
 * rule is a different, genuinely internal case (ATLAS DOES operate the
 * flight, but the rule for it isn't confirmed yet) — that one keeps its
 * needs_configuration: true row, surfaced only as an administrative
 * PlanIssue (see validation.ts), never as a routine Flight Coverage state.
 */
export function classifyFlightRequirements(
  flight: Flight,
  config: Config
): Omit<StaffingRequirement, "id" | "flight_id">[] {
  if (flight.operator_type === "self_managed") {
    const companyRequirement = classifyCompanyRequirement(flight);
    return companyRequirement ? [companyRequirement] : [];
  }

  const checkin = isCheckinApplicable(flight)
    ? [computeGeneralizedCheckinRequirement(flight, config.checkin_demand_policy)]
    : [];

  const gateAndBoarding = classifyRamGateAndBoardingRequirements(flight);
  if (!gateAndBoarding) {
    // No established rule at all for this (aircraft, destination category)
    // combination — one honest "needs configuration" row for Gate/
    // Boarding/Profiling/Mesure, not a separate fabricated row per role.
    // Check-in is reported alongside it regardless (see the module doc
    // comment above) rather than being swallowed by the same
    // needs_configuration placeholder — they are genuinely independent
    // facts about this flight.
    return [...checkin, missingOperationRuleRequirement(flight)];
  }

  const specialized = [classifyProfilingRequirement(flight), classifyMesureRequirement(flight)].filter(
    (r): r is Omit<StaffingRequirement, "id" | "flight_id"> => r !== null
  );

  return [...checkin, ...gateAndBoarding, ...specialized];
}

/**
 * Computes staffing requirements for every flight in the given set — the
 * first pipeline stage ("Weekly flight schedule → RAM staffing
 * requirements → total demand"). One requirement PER ROLE per flight (a
 * flight can have several — Gate, Boarding, Profiling, ...), each with a
 * deterministic id matching the existing seed convention
 * (req-<flightId>-<role>) so this stays a drop-in replacement for the
 * per-flight logic already used at seed time, not a parallel one.
 */
export function computeWeeklyStaffingRequirements(flights: Flight[], config: Config): StaffingRequirement[] {
  return flights.flatMap((flight) => {
    const classifiedList = classifyFlightRequirements(flight, config);
    return classifiedList.map((classified) => {
      const id = `req-${flight.id}-${classified.role.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      return { id, flight_id: flight.id, ...classified };
    });
  });
}
