import { Flight, StaffingRequirement, Config } from "../types";
import { classifyRamGateAndBoardingRequirements, missingOperationRuleRequirement } from "../operation-rules";
import { classifyProfilingRequirement, classifyMesureRequirement } from "./specialized-demand";
import { classifyCompanyRequirement } from "../company-config";

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
 * applicable). Self-managed (foreign carrier) flights go through
 * company-config.ts instead.
 *
 * CHECK-IN — CUT OVER to the T1 ZONE model (2026-09-21): this function no
 * longer produces a per-flight "Check-in" StaffingRequirement row for any
 * RAM flight. RAM does not staff Check-in per flight in reality — see
 * lib/checkin-zones.ts's module doc comment for the confirmed real
 * pipeline (flight -> zone -> combined zone workload -> required
 * workforce -> zone assignment). Check-in demand/coverage is now computed
 * entirely by the zone engine (lib/planning/zone-demand-aggregation.ts,
 * lib/planning/checkin-zone-placement.ts) and persisted separately (see
 * checkin_zone_requirements/checkin_zone_assignments,
 * supabase/migrations/0015_checkin_zones.sql) — never as a
 * StaffingRequirement row any more. The old per-flight model
 * (checkin-demand.ts's isCheckinApplicable/computeGeneralizedCheckinRequirement)
 * is INTENTIONALLY left in the codebase, unreferenced from this live path
 * — some types/tests still reference CheckinDemandPolicy — but is never
 * called from here again. Gate/Boarding/Profiling/Mesure generation below
 * is completely unaffected by this change.
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

  const gateAndBoarding = classifyRamGateAndBoardingRequirements(flight);
  if (!gateAndBoarding) {
    // No established rule at all for this (aircraft, destination category)
    // combination — one honest "needs configuration" row for Gate/
    // Boarding/Profiling/Mesure, not a separate fabricated row per role.
    // Check-in is never part of this list any more (see the module doc
    // comment above) — it's computed entirely by the separate zone engine.
    return [missingOperationRuleRequirement(flight)];
  }

  const specialized = [classifyProfilingRequirement(flight), classifyMesureRequirement(flight)].filter(
    (r): r is Omit<StaffingRequirement, "id" | "flight_id"> => r !== null
  );

  return [...gateAndBoarding, ...specialized];
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
