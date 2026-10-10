import { Flight } from "../types";
import { CheckinZoneId, CHECKIN_ZONES, classifyCheckinZone } from "../checkin-zones";
import { isDreamlinerAircraft } from "../ram-staffing-matrix";
import { CheckinCategoryKey } from "./checkin-demand";

/**
 * ZONE-LEVEL Check-in demand — the replacement shape for the old per-flight
 * `CheckinDemandPolicy` (checkin-demand.ts), adapted per the product
 * owner's brief: RAM does not staff Check-in per flight, it staffs a
 * shared zone. This module answers "how many agents does THIS ZONE need
 * during this time bucket, given every flight currently open there,"
 * never "how many agents does this one flight need."
 *
 * STATUS: exactly as prototype/unconfirmed as the model it replaces (see
 * checkin-demand.ts's own doc comment) — none of the coefficients below
 * are confirmed RAM management policy. They deliberately REUSE
 * checkin-demand.ts's existing prototype coefficients (base_agents,
 * category_overrides, Dreamliner delta, booking-pressure delta) rather
 * than inventing a new "real-sounding" formula, per the explicit
 * instruction not to fabricate a coefficient. The only genuinely NEW
 * modeling decision here is the AGGREGATION axis (per zone/time-bucket
 * instead of per flight) — see lib/planning/zone-demand-aggregation.ts for
 * how each flight's own contribution (computed by this module) is
 * combined into simultaneous zone workload.
 *
 * Business Check-in, Staff Check-in, and Oversized Baggage
 * (CHECKIN_ZONES[...].demandMode === "manual") never receive an automatic
 * per-flight contribution from this module — see
 * contributionForFlight's early return.
 */
export interface ZoneCheckinDemandPolicy {
  /** Same meaning as CheckinDemandPolicy's field of the same name — kept as ONE window policy shared by every automatic zone today (no real per-zone opening-time difference has been confirmed). */
  open_minutes_before_departure: number;
  close_minutes_before_departure: number;
  /**
   * Per-zone coefficients, keyed by CheckinZoneId. Only zones with
   * `demandMode: "automatic"` (see checkin-zones.ts) need an entry; a
   * "manual" zone is simply never looked up here (contributionForFlight
   * returns 0 before consulting this map). Reuses the exact prototype
   * shape/values from DEFAULT_CHECKIN_DEMAND_POLICY, duplicated per
   * automatic zone rather than invented fresh per zone — i.e. today every
   * automatic zone happens to use IDENTICAL coefficients, which is itself
   * an honest placeholder (no real zone-specific difference has been
   * confirmed), not a claim that Main/Italy-Spain/Domestic genuinely need
   * the same staffing shape.
   */
  zone_coefficients: Partial<
    Record<
      CheckinZoneId,
      {
        base_agents: number;
        category_overrides: Partial<Record<CheckinCategoryKey, number>>;
        dreamliner_extra_agents: number;
        overbooking_reinforcement_agents: number;
        minimum_agents_per_active_flight: number;
      }
    >
  >;
}

/**
 * CONFIRMED by the product owner (2026-09-23 architecture audit): T1
 * Check-in opens exactly 4 hours before a flight's scheduled departure.
 * This replaces the earlier, unconfirmed 180-minute prototype value —
 * named here (never inlined) so the one real, confirmed fact in this
 * module's timing model is never confused with the coefficients below,
 * which remain prototype/unconfirmed.
 */
export const CHECKIN_OPEN_BEFORE_DEPARTURE_MINUTES = 240;

/**
 * UNCONFIRMED / PROTOTYPE: the real Check-in CLOSING point relative to
 * departure has not been confirmed by RAM management (see the product
 * owner's 2026-09-23 brief, point 2). Kept as its own explicitly-named
 * constant — never hardcoded inline — so it can be corrected the moment a
 * real number is confirmed without hunting through call sites. Weekly
 * Planning uses planned departure times only; delay-shifted Check-in
 * closing is an explicitly deferred future concern.
 */
export const CHECKIN_CLOSE_BEFORE_DEPARTURE_MINUTES = 45;

export const DEFAULT_ZONE_CHECKIN_DEMAND_POLICY: ZoneCheckinDemandPolicy = {
  open_minutes_before_departure: CHECKIN_OPEN_BEFORE_DEPARTURE_MINUTES,
  close_minutes_before_departure: CHECKIN_CLOSE_BEFORE_DEPARTURE_MINUTES,
  zone_coefficients: {
    t1_main_checkin: {
      base_agents: 2,
      category_overrides: { "UK/USA": 1, Canada: 1, "Europe/Schengen": 0, Africa: 0, domestic: 0 },
      dreamliner_extra_agents: 1,
      overbooking_reinforcement_agents: 2,
      minimum_agents_per_active_flight: 1,
    },
    t1_italy_spain: {
      base_agents: 2,
      category_overrides: { "UK/USA": 1, Canada: 1, "Europe/Schengen": 0, Africa: 0, domestic: 0 },
      dreamliner_extra_agents: 1,
      overbooking_reinforcement_agents: 2,
      minimum_agents_per_active_flight: 1,
    },
    t1_domestic: {
      base_agents: 2,
      category_overrides: { "UK/USA": 1, Canada: 1, "Europe/Schengen": 0, Africa: 0, domestic: 0 },
      dreamliner_extra_agents: 1,
      overbooking_reinforcement_agents: 2,
      minimum_agents_per_active_flight: 1,
    },
  },
};

function categoryKeyFor(flight: Flight): CheckinCategoryKey {
  return (flight.destination_category as CheckinCategoryKey | null) ?? "domestic";
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(mins: number): string {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

/** Same window shape as checkin-demand.ts's getCheckinWindow, but for the zone-level policy — a flight's own Check-in-open interval, before it's combined with every other flight sharing its zone. CLAMPED to [00:00, departure) for the flight's own scheduled-departure calendar day — this is the pre-existing, unchanged behavior every existing caller (and Stage 6's T1 demand-bias input) still gets; see getFlightCheckinWindowUnclamped/flightCheckinSpilloverMinutesIntoPreviousDay below for the additive, opt-in cross-midnight handling. */
export function getFlightCheckinWindow(flight: Flight, policy: ZoneCheckinDemandPolicy): { start: string; end: string } {
  const departureMinutes = timeToMinutes(flight.scheduled_departure);
  const startMinutes = Math.max(0, departureMinutes - policy.open_minutes_before_departure);
  const endMinutes = Math.max(0, departureMinutes - policy.close_minutes_before_departure);
  return { start: minutesToTime(startMinutes), end: minutesToTime(Math.max(startMinutes, endMinutes)) };
}

/**
 * UNCLAMPED variant of getFlightCheckinWindow — the raw, signed-minute
 * window relative to the flight's own scheduled-departure calendar day,
 * with NO Math.max(0, ...) floor. A negative `startMinutes` means the
 * window genuinely reaches back before midnight of that day (an
 * early-morning flight whose Check-in opens the previous calendar day).
 * Never used by any existing caller — only by
 * flightCheckinSpilloverMinutesIntoPreviousDay below, which is itself only
 * consulted by callers that explicitly opt in to cross-midnight demand
 * (an optional `nextDayOfWeek`/`nextDayFlights` parameter — see
 * zone-demand-aggregation.ts and checkin-capacity-timeline.ts).
 */
export function getFlightCheckinWindowUnclamped(flight: Flight, policy: ZoneCheckinDemandPolicy): { startMinutes: number; endMinutes: number } {
  const departureMinutes = timeToMinutes(flight.scheduled_departure);
  const startMinutes = departureMinutes - policy.open_minutes_before_departure;
  const endMinutes = departureMinutes - policy.close_minutes_before_departure;
  return { startMinutes, endMinutes: Math.max(startMinutes, endMinutes) };
}

/**
 * The portion (if any) of a flight's Check-in-open window that falls
 * BEFORE midnight of the flight's own scheduled-departure calendar day —
 * i.e. the real previous-calendar-day spillover for an early-morning
 * flight (e.g. a 03:15 departure with a 240-minute opening reaches back to
 * 23:15 the night before). Returns null when the window never reaches
 * back past midnight (the ordinary case for every flight whose departure
 * is not within `open_minutes_before_departure` of midnight).
 *
 * Expressed in minutes on the PREVIOUS calendar day's own 0..1440 clock
 * (close to end-of-day — e.g. 1395..1440 for the 23:15 example above;
 * `endMinutes` may legitimately equal 1440, representing exactly
 * midnight, so this deliberately returns numbers, never an "HH:MM"
 * string, which cannot represent 24:00). This is ADDITIVE-ONLY by
 * construction: it only ever describes the part of the window strictly
 * before midnight, never touching [0, this flight's own endMinutes) —
 * the flight's unchanged, clamped getFlightCheckinWindow forward portion
 * — so a caller that evaluates this flight once as a `nextDayFlights`
 * spillover on the previous day and once normally on its own day can
 * never double-count any minute.
 */
export function flightCheckinSpilloverMinutesIntoPreviousDay(
  flight: Flight,
  policy: ZoneCheckinDemandPolicy
): { startMinutes: number; endMinutes: number } | null {
  const { startMinutes, endMinutes } = getFlightCheckinWindowUnclamped(flight, policy);
  if (startMinutes >= 0) return null; // window never reaches back past midnight
  const spillEndMinutes = Math.min(endMinutes, 0); // only the part still before midnight
  if (spillEndMinutes <= startMinutes) return null; // degenerate/empty (should not occur given endMinutes >= startMinutes above)
  return { startMinutes: startMinutes + 1440, endMinutes: spillEndMinutes + 1440 };
}

/**
 * One flight's INCREMENTAL headcount contribution to its zone — deliberately
 * NOT the full base+delta total the old per-flight model computed. This is
 * the core of "aggregate simultaneous zone workload, not summed
 * independently per flight": `base_agents` represents the minimum crew
 * needed to keep the zone's counters open AT ALL while ANY flight is
 * active there (applied ONCE per zone/bucket by the aggregation engine —
 * see zone-demand-aggregation.ts's aggregateZoneDailyDemand — never once
 * per flight), while this function returns only the EXTRA agents this
 * specific flight's own complexity (destination category, aircraft,
 * booking pressure) adds on top of that shared baseline. Summing these
 * increments across every flight simultaneously open in the zone, plus
 * the single shared base, is what "combined workload in that zone" means
 * here — a real aggregation, not N independent copies of the same
 * baseline.
 *
 * Returns null for a flight whose classified zone is null (unclassifiable
 * destination — same honesty convention as classifyCheckinZone) or whose
 * zone is demandMode: "manual" (Business/Staff/Oversized — no automatic
 * formula, see the module doc comment).
 */
export function checkinIncrementForFlight(flight: Flight, policy: ZoneCheckinDemandPolicy): { zone: CheckinZoneId; increment: number } | null {
  const zone = classifyCheckinZone(flight.destination);
  if (!zone) return null;
  if (CHECKIN_ZONES[zone].demandMode !== "automatic") return null;

  const coeff = policy.zone_coefficients[zone];
  if (!coeff) return null;

  let increment = coeff.category_overrides[categoryKeyFor(flight)] ?? 0;
  if (isDreamlinerAircraft(flight.aircraft)) increment += coeff.dreamliner_extra_agents;
  if (flight.booking_pressure === "elevated") increment += coeff.overbooking_reinforcement_agents;

  return { zone, increment };
}

/** The shared per-zone baseline (applied once per bucket the zone has any active flight) and per-active-flight floor — exposed separately so the aggregation engine, not this module, decides how they combine across multiple simultaneous flights. */
export function zoneBaseAgents(zone: CheckinZoneId, policy: ZoneCheckinDemandPolicy): number {
  return policy.zone_coefficients[zone]?.base_agents ?? 0;
}
export function zoneMinimumPerActiveFlight(zone: CheckinZoneId, policy: ZoneCheckinDemandPolicy): number {
  return policy.zone_coefficients[zone]?.minimum_agents_per_active_flight ?? 0;
}
