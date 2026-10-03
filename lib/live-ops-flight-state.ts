import { LiveOpsFlightView } from "./live-ops-service";

/**
 * A flight's overall, at-a-glance Live Operations state -- derived purely
 * from data already in the GET /api/live-ops response plus whether this
 * flight currently has an active (unconfirmed) conflict open in the Edit
 * Flight flow. Deliberately a simple priority order, not a scoring system
 * (see the UI agent's own brief): Conflict > Gap > Delayed > Covered.
 */
export type LiveOpsFlightState = "conflict" | "gap" | "delayed" | "covered";

/**
 * `hasActiveConflict` is caller-supplied (true while this flight's Edit
 * Flight drawer has an evaluate-impact result with unresolved conflicts
 * open) -- this module has no notion of "active" on its own, since that's
 * ephemeral UI state, not something the live-ops API response carries.
 */
export function deriveFlightState(view: LiveOpsFlightView, hasActiveConflict: boolean): LiveOpsFlightState {
  if (hasActiveConflict) return "conflict";
  if (view.requirements.some((r) => r.coverageStatus === "gap" || r.coverageStatus === "conflict")) return "gap";
  const delayed = view.flight.status === "delayed" || view.effectiveDeparture !== view.flight.scheduled_departure;
  if (delayed) return "delayed";
  return "covered";
}

export const FLIGHT_STATE_LABEL: Record<LiveOpsFlightState, string> = {
  conflict: "Conflict",
  gap: "Gap",
  delayed: "Delayed",
  covered: "Covered",
};
