import { Flight, Config, StaffingRequirement } from "./types";

/**
 * Planning Engine demand-forecast logic for Terminal 1 Check-in/ACE.
 * Deliberately scoped to this one role — there is no generic overbooking
 * multiplier applied across roles. Extending demand-forecasting to another
 * role means writing another explicit function, not parameterizing this one.
 *
 * Runs at planning time only. Never called from Live Operations.
 */
export function computeCheckinRequirement(
  flight: Flight,
  config: Config
): Omit<StaffingRequirement, "id" | "flight_id"> {
  const baseline = config.baseline_checkin_requirement;

  if (flight.booking_pressure === "elevated") {
    const additional = config.overbooking_checkin_reinforcement;
    return {
      role: "Check-in/ACE",
      baseline_requirement: baseline,
      additional_requirement: additional,
      total_requirement: baseline + additional,
      source: "demand_forecast",
      reasoning: `Elevated booking/overbooking pressure detected for ${flight.flight_number}. Normal Terminal 1 Check-in requirement: ${baseline}. Additional reinforcement: +${additional}.`,
    };
  }

  return {
    role: "Check-in/ACE",
    baseline_requirement: baseline,
    additional_requirement: 0,
    total_requirement: baseline,
    source: "demand_forecast",
    reasoning: `Normal booking levels — baseline Check-in requirement: ${baseline}.`,
  };
}

/**
 * Fixed-rule staffing requirement for Boarding. Separate code path from
 * demand forecasting — Boarding does not respond to booking pressure.
 */
export function computeBoardingRequirement(
  flight: Flight
): Omit<StaffingRequirement, "id" | "flight_id"> {
  const baseline = 3; // per Boeing 737-800 configuration, this operator's rule
  return {
    role: "Boarding",
    baseline_requirement: baseline,
    additional_requirement: 0,
    total_requirement: baseline,
    source: "fixed_rule",
    reasoning: `${baseline} Boarding agents required per ${flight.aircraft} configuration.`,
  };
}
