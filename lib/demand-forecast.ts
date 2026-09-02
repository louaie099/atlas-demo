import { Flight, Config, StaffingRequirement } from "./types";

/**
 * Planning Engine demand-forecast logic for Terminal 1 Check-in.
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
      role: "Check-in",
      baseline_requirement: baseline,
      additional_requirement: additional,
      total_requirement: baseline + additional,
      source: "demand_forecast",
      reasoning: `Elevated booking/overbooking pressure detected for ${flight.flight_number}. Normal Terminal 1 Check-in requirement: ${baseline}. Additional reinforcement: +${additional}.`,
      needs_configuration: false,
    };
  }

  return {
    role: "Check-in",
    baseline_requirement: baseline,
    additional_requirement: 0,
    total_requirement: baseline,
    source: "demand_forecast",
    reasoning: `Normal booking levels — baseline Check-in requirement: ${baseline}.`,
    needs_configuration: false,
  };
}

/**
 * Fixed-rule staffing requirement for Boarding, with a manually-specified
 * baseline. Used only by the "Add Flight" UI form, where a planner enters
 * a one-off baseline directly rather than relying on the RAM operation
 * rule table (see operation-rules.ts) — that table drives the seeded RAM
 * flights (AT201, AT880) instead.
 */
export function computeBoardingRequirement(
  flight: Flight,
  baseline = 3
): Omit<StaffingRequirement, "id" | "flight_id"> {
  return {
    role: "Boarding",
    baseline_requirement: baseline,
    additional_requirement: 0,
    total_requirement: baseline,
    source: "fixed_rule",
    reasoning: `${baseline} Boarding agents required per ${flight.aircraft} configuration (manually specified).`,
    needs_configuration: false,
  };
}
