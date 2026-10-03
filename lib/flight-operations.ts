import { Flight } from "./types";

/**
 * The ONE place "what time is this flight actually leaving at, for
 * operational purposes" is computed. `flight.scheduled_departure` is the
 * immutable planning-time fact (see its own doc comment in lib/types.ts)
 * — it must never be mutated by live-ops code, and no other reader should
 * reach into `actual_departure` directly, so a day the window-computation
 * code starts caring about the operational time can't silently miss a
 * spot that still read `scheduled_departure`.
 *
 * Feed the result into `getRequirementWindow` via a shallow copy, e.g.
 * `getRequirementWindow(requirement, { ...flight, scheduled_departure: effectiveDeparture(flight) })`
 * — `getRequirementWindow` itself stays completely unchanged.
 */
export function effectiveDeparture(flight: Flight): string {
  return flight.actual_departure ?? flight.scheduled_departure;
}
