import { Flight, StaffingRequirement, Config } from "../types";
import { isDreamlinerAircraft } from "../ram-staffing-matrix";

/**
 * GENERALIZED Check-in demand model — replaces the old AT535-only special
 * case (see weekly-requirements.ts's prior `flight.id === "at535"` branch,
 * now removed). Check-in is a real RAM ground-service function that every
 * RAM (atlas_managed) flight needs, not a property of one demo flight —
 * so this model applies uniformly to every atlas_managed flight, keyed
 * only off fields that already exist on Flight (never a per-flight-number
 * special case).
 *
 * IMPORTANT — confirmed-vs-prototype status: unlike the RAM Gate/Boarding/
 * Profiling/Mesure matrix (ram-staffing-matrix.ts), which the operational
 * brief explicitly confirmed, NONE of the numbers below have been
 * confirmed as real management policy. `DEFAULT_CHECKIN_DEMAND_POLICY` is
 * a deliberately configurable PROTOTYPE model — every field is a
 * plausible placeholder, not a researched real-world Check-in policy.
 * This mirrors how lib/labor-rules.ts marks unconfirmed values
 * (`unconfirmed_prototype`) rather than silently presenting a guess as
 * settled fact. Do not read any number in DEFAULT_CHECKIN_DEMAND_POLICY as
 * "this is what RAM actually does" — read it as "this is the shape of the
 * lever ATLAS exposes, waiting for a real confirmed value."
 *
 * Design (per the accepted proposal):
 *  - WHEN Check-in opens/closes: pure minutes-before-scheduled-departure
 *    offsets (`open_minutes_before_departure` / `close_minutes_before_departure`),
 *    completely independent of the RAM Gate/Boarding/Profiling window
 *    (requirement-window.ts's RAM_REQUIREMENT_LEAD_MINUTES) — Check-in is
 *    a genuinely different operational window (opens much earlier, closes
 *    well before departure), not a relabeling of the boarding window.
 *  - HEADCOUNT: `base_agents` unconditionally, PLUS an optional
 *    passenger-load scaling term (`passengers_per_agent` — null means "not
 *    modeled," since Flight.booked_passengers is architecture-only per its
 *    own doc comment and no real ratio has been confirmed), PLUS a flat
 *    per-category override delta (destination category, or a `domestic`
 *    bucket for flights with no destination_category), PLUS a flat
 *    Dreamliner delta, PLUS the existing booking-pressure reinforcement —
 *    then clamped to [minimum_agents, maximum_agents].
 *  - BUSINESS / SPECIAL COUNTERS: NOT modeled. Flight/Employee/skills carry
 *    no concept of a Business-class or dedicated/priority Check-in
 *    counter today (no field on Flight distinguishes cabin mix, and
 *    "Check-in" is a single flat skill in Employee.skills — see
 *    workforce-pools.ts). Representing it for real would need either a
 *    Flight-level premium-passenger-count field or a distinct
 *    "Check-in-Business" skill/role, neither of which exists — inventing
 *    either would be fabricating operational data this milestone was
 *    explicitly told not to invent. This is called out as a known
 *    simplification, not silently ignored: see the `dedicated counters`
 *    note in the reasoning string below.
 */

export type CheckinCategoryKey = "domestic" | "Africa" | "Europe/Schengen" | "UK/USA" | "Canada";

export interface CheckinDemandPolicy {
  /** Minutes before scheduled_departure the Check-in window OPENS (demand begins). Prototype value — not confirmed. */
  open_minutes_before_departure: number;
  /** Minutes before scheduled_departure the Check-in window CLOSES (demand ends). Prototype value — not confirmed. */
  close_minutes_before_departure: number;
  /** Agents required regardless of passenger load. Prototype value — not confirmed. */
  base_agents: number;
  /**
   * Additional agents per this many booked passengers, applied only when
   * `Flight.booked_passengers` is present (it's optional/architecture-only
   * — see types.ts). null = passenger-load scaling is NOT modeled at all
   * (the honest default, since no real ratio has been confirmed) rather
   * than silently assuming a made-up ratio.
   */
  passengers_per_agent: number | null;
  /** Hard floor after every other term is added. Prototype value. */
  minimum_agents: number;
  /** Hard ceiling after every other term is added. null = uncapped. Prototype value. */
  maximum_agents: number | null;
  /**
   * Flat additional agents for a Dreamliner (787) flight, added on top of
   * base_agents/category overrides — mirrors the aircraft-class dimension
   * the confirmed RAM matrix already uses for Gate/Boarding/Profiling, but
   * this specific number is NOT part of that confirmed matrix and is a
   * prototype placeholder pending real confirmation.
   */
  dreamliner_extra_agents: number;
  /**
   * Flat additional-agents delta per destination category (or "domestic"
   * for a flight with no destination_category) — e.g. a long-haul
   * UK/USA/Canada flight's Check-in may plausibly need more agents than a
   * short domestic hop. Every entry is a prototype placeholder; an absent
   * key means "no override, use base_agents as-is."
   */
  category_overrides: Partial<Record<CheckinCategoryKey, number>>;
  /** Additional agents when Flight.booking_pressure === "elevated" — folds in the existing overbooking_checkin_reinforcement concept, generalized to every RAM flight instead of only AT535. */
  overbooking_reinforcement_agents: number;
}

/**
 * Prototype defaults. Every number here is `unconfirmed_prototype`-grade,
 * not `confirmed_management_policy` — see the module doc comment. Kept
 * intentionally modest (rather than dramatic) so a whole-demo run doesn't
 * manufacture an implausible headcount swing while these are still
 * placeholders.
 */
export const DEFAULT_CHECKIN_DEMAND_POLICY: CheckinDemandPolicy = {
  open_minutes_before_departure: 180, // T-3h — a common real-world convention, NOT confirmed for this operation
  close_minutes_before_departure: 45, // T-45min — NOT confirmed
  base_agents: 2,
  passengers_per_agent: null, // passenger-load scaling not modeled until booked_passengers-driven policy is confirmed
  minimum_agents: 1,
  maximum_agents: 6,
  dreamliner_extra_agents: 1,
  category_overrides: {
    "UK/USA": 1,
    Canada: 1,
    "Europe/Schengen": 0,
    Africa: 0,
    domestic: 0,
  },
  overbooking_reinforcement_agents: 2, // mirrors the old overbooking_checkin_reinforcement default
};

/** Whether Check-in demand applies to this flight at all. RAM (atlas_managed) flights only — a self_managed (foreign carrier) flight's own Check-in is that carrier's responsibility and, where ATLAS provides ground service for it, is already represented as its own company_config requirement (company-config.ts), never doubled up here. */
export function isCheckinApplicable(flight: Flight): boolean {
  return flight.operator_type === "atlas_managed";
}

function categoryKeyFor(flight: Flight): CheckinCategoryKey {
  return (flight.destination_category as CheckinCategoryKey | null) ?? "domestic";
}

/**
 * The Check-in operational window for one flight — independent of the RAM
 * Gate/Boarding/Profiling window (requirement-window.ts). Clamped so it
 * never reports a negative offset from midnight; a flight departing early
 * enough that `open_minutes_before_departure` would fall on the PREVIOUS
 * calendar day is a genuine simplification of this milestone (the
 * bucketed demand model, like the rest of the pipeline, is per-day and
 * has no cross-midnight representation yet) — clamped to "00:00" rather
 * than silently wrapping into the wrong day.
 */
export function getCheckinWindow(flight: Flight, policy: CheckinDemandPolicy): { start: string; end: string } {
  const [dh, dm] = flight.scheduled_departure.split(":").map(Number);
  const departureMinutes = dh * 60 + dm;
  const startMinutes = Math.max(0, departureMinutes - policy.open_minutes_before_departure);
  const endMinutes = Math.max(0, departureMinutes - policy.close_minutes_before_departure);
  const toTime = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return { start: toTime(startMinutes), end: toTime(Math.max(startMinutes, endMinutes)) };
}

/**
 * The Check-in headcount for one flight — base + optional passenger-load
 * scaling + category override + Dreamliner delta + booking-pressure
 * reinforcement, clamped to [minimum_agents, maximum_agents]. Every term
 * is additive and independently toggleable (a null/zero term simply drops
 * out), so disabling any one lever (e.g. once passenger-load scaling gets
 * a real confirmed ratio, or category overrides get replaced with real
 * numbers) never requires touching this function.
 */
export function computeCheckinHeadcount(flight: Flight, policy: CheckinDemandPolicy): number {
  let agents = policy.base_agents;

  if (policy.passengers_per_agent && policy.passengers_per_agent > 0 && flight.booked_passengers) {
    agents += Math.ceil(flight.booked_passengers / policy.passengers_per_agent);
  }

  agents += policy.category_overrides[categoryKeyFor(flight)] ?? 0;

  if (isDreamlinerAircraft(flight.aircraft)) {
    agents += policy.dreamliner_extra_agents;
  }

  if (flight.booking_pressure === "elevated") {
    agents += policy.overbooking_reinforcement_agents;
  }

  agents = Math.max(policy.minimum_agents, agents);
  if (policy.maximum_agents !== null) agents = Math.min(policy.maximum_agents, agents);
  return agents;
}

/**
 * Builds the generalized Check-in StaffingRequirement for one RAM flight —
 * the drop-in replacement for demand-forecast.ts's old
 * computeCheckinRequirement, generalized from "AT535 only" to every
 * atlas_managed flight (see isCheckinApplicable). `source` stays
 * "demand_forecast" (an unchanged, already-modeled RequirementSource) —
 * only the SCOPE of which flights get one, and the formula behind the
 * number, changed.
 */
export function computeGeneralizedCheckinRequirement(
  flight: Flight,
  policy: CheckinDemandPolicy
): Omit<StaffingRequirement, "id" | "flight_id"> {
  const total = computeCheckinHeadcount(flight, policy);
  const categoryKey = categoryKeyFor(flight);
  const categoryNote = policy.category_overrides[categoryKey]
    ? `, +${policy.category_overrides[categoryKey]} for ${categoryKey}`
    : "";
  const dreamlinerNote = isDreamlinerAircraft(flight.aircraft) ? `, +${policy.dreamliner_extra_agents} for Dreamliner` : "";
  const pressureNote = flight.booking_pressure === "elevated" ? `, +${policy.overbooking_reinforcement_agents} for elevated booking pressure` : "";

  return {
    role: "Check-in",
    baseline_requirement: policy.base_agents,
    additional_requirement: total - policy.base_agents,
    total_requirement: total,
    source: "demand_forecast",
    reasoning: `${total} Check-in agent(s) for ${flight.flight_number} — base ${policy.base_agents}${categoryNote}${dreamlinerNote}${pressureNote} (prototype/configurable Check-in demand policy, not yet confirmed management policy; dedicated Business/priority counters are not separately modeled — see lib/planning/checkin-demand.ts).`,
    needs_configuration: false,
  };
}
