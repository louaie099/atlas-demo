import { Flight } from "./types";
import { LiveOpsFlightView } from "./live-ops-service";
import { resolveFlightPhase } from "./flight-phase";

/**
 * Proactive Notifications / Attention Center (Live Operations phase 2,
 * 2026-10-09) — ALERT DETECTION AND LIFECYCLE.
 *
 * Deliberately built entirely on top of what GET /api/live-ops already
 * returns (LiveOpsFlightView[], specifically each requirement's
 * EFFECTIVE `coverageStatus`/`gap`/`invalidatedAssignments`/
 * `gapResolution` — see live-ops-service.ts's own doc comments, all from
 * the 2026-10-09 invalidated-coverage fix). No new backend computation,
 * no new database reads: an operational problem is detected the moment
 * it shows up in the SAME data the board/header/drawer already render,
 * on every ordinary page load or refresh — never only when a human has
 * opened a specific flight's Edit Flight drawer. That dependency (the
 * previous lib/live-ops-notifications.ts's buildDelayImpactNotification,
 * only ever invoked from inside components/flight-drawer.tsx's
 * evaluate-impact call) was the actual gap this phase closes; that file
 * is left in place, unreferenced, rather than deleted (same convention
 * this codebase already uses for a superseded model — see
 * lib/planning/checkin-demand.ts's own doc comment).
 *
 * SCOPE — what this generates an alert for, mapped to the product ask:
 *  - "A flight delay invalidating one or more assigned agents" ->
 *    `kind: "invalidation"` (any affected requirement has a non-empty
 *    `invalidatedAssignments`).
 *  - "A Gate, Boarding, Mesure or Profiling staffing shortage" ->
 *    `kind: "shortage"` (an ordinary never-staffed `gap`, no
 *    invalidation involved). Both kinds are detected through the exact
 *    same `coverageStatus === "gap" || "conflict"` signal the board
 *    itself already uses for Needs Attention — there is only one
 *    definition of "this requirement has a problem" anywhere in Live
 *    Operations.
 *  - "A previously valid assignment becoming impossible because of a
 *    shift boundary or overlapping duty" -> already IS what populates
 *    `invalidatedAssignments` (see live-ops-service.ts's
 *    findInvalidatedAssignments) -- surfaces as `kind: "invalidation"`.
 *  - "A flight approaching its operational window with insufficient
 *    valid staffing" -> a severity ESCALATION, not a separate alert
 *    type: an unresolved shortage still open once the flight has
 *    entered its boarding window (lib/flight-phase.ts's own existing
 *    thresholds -- never a new, second timing model) is `critical`
 *    rather than `warning`.
 *  - "An aircraft change affecting staffing requirements" -> NOT
 *    currently detectable. Live Operations' own operational edit route
 *    (app/api/flights/[id]/operational/route.ts) never accepts an
 *    aircraft field at all, and the Flight Schedule "Edit Flight" PUT
 *    route that CAN change aircraft writes straight into
 *    scheduled_departure/aircraft with no operational-impact evaluation
 *    of any kind (a separate, already-flagged architectural gap — see
 *    APPLY_NOTES_0101.txt). Building aircraft-change detection would mean
 *    adding a new "previous aircraft" tracking mechanism that does not
 *    exist anywhere in the schema today — out of scope for "the smallest
 *    reliable solution," and explicitly out of scope per this phase's
 *    own constraint against unrelated refactoring. Left undetected,
 *    honestly, rather than faked.
 *
 * LIFECYCLE — one alert ID per flight (`alert-<flightId>`), never one per
 * requirement, so four simultaneous invalidated requirements on the same
 * flight are exactly one consolidated alert (section 5's explicit AT815
 * example), and so recomputing this on every refresh naturally updates
 * the SAME alert rather than minting a new one (section 5: "repeated API
 * refreshes must not generate duplicate notifications"). `reconcileAlerts`
 * is the only place state transitions happen:
 *   - no problem now, alert was open (new/acknowledged) -> resolved
 *     (section 4: automatic resolution, the instant the underlying cause
 *     disappears — a confirmed replacement, a reversed delay, or any
 *     other change that clears every affected requirement).
 *   - no problem now, alert was already resolved -> carried forward
 *     unchanged (history, not re-resolved every refresh).
 *   - problem now, no alert yet, or the existing alone was resolved ->
 *     a fresh "new" alert (a genuine reappearance of a resolved problem
 *     is handled identically to a brand-new one, with `reopenedCount`
 *     incremented so the Attention Center can show it is not the first
 *     occurrence — section 5).
 *   - problem now, alert already open (new/acknowledged) -> content
 *     refreshed in place, STATE PRESERVED — an acknowledgment is never
 *     silently reset by a routine refresh, and acknowledging is
 *     explicitly NOT resolving (section 3): only the reconciliation
 *     above (the underlying cause actually clearing) ever moves an alert
 *     to "resolved".
 *
 * PERSISTENCE (section 8): deliberately still in-memory/client-side, same
 * stated scope decision as the superseded module (see
 * lib/live-ops-notifications.ts's own doc comment) — this reconciliation
 * is pure and cheap enough to re-run from scratch on every fetch, so no
 * new table or migration is needed for alerts to behave correctly on an
 * ordinary refresh: a genuinely still-open problem is RE-DETECTED from
 * the live view every time, so a page reload can never make a real
 * problem look resolved (worst case it re-appears as "new" rather than
 * keeping an "acknowledged" read marker — see APPLY_NOTES for the full
 * trade-off and the smallest follow-up that would close even that gap).
 */

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "new" | "acknowledged" | "resolved";
export type AlertKind = "invalidation" | "shortage";

export interface OperationalAlert {
  /** Stable per flight — `alert-<flightId>` — never per requirement. */
  id: string;
  flightId: string;
  flightNumber: string;
  destination: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  state: AlertState;
  title: string;
  detail: string;
  /** Every currently-affected requirement id, for click-through/focus. */
  requirementIds: string[];
  /** Total unfilled seats across the affected requirements right now (the "N affected" the product spec asks for). */
  affectedCount: number;
  /** First detection of this occurrence (resets if a resolved alert reopens). */
  detectedAt: number;
  /** Bumped every refresh the underlying problem is still present. */
  lastSeenAt: number;
  acknowledgedAt?: number;
  resolvedAt?: number;
  /** 0 for an alert's first occurrence; incremented each time a resolved alert's problem reappears. */
  reopenedCount: number;
}

export const ALERT_SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};

interface FlightProblem {
  kind: AlertKind;
  severity: AlertSeverity;
  requirementIds: string[];
  affectedCount: number;
  detail: string;
}

/**
 * Pure per-flight detection — null when every requirement reads
 * "assigned" (nothing to alert on). Reuses `coverageStatus`/`gap`/
 * `invalidatedAssignments`/`gapResolution` exactly as computed by
 * loadLiveOpsView; never recomputes or second-guesses them.
 */
function detectFlightProblem(view: LiveOpsFlightView, nowMinutesSinceMidnight: number | null): FlightProblem | null {
  const problemRequirements = view.requirements.filter((r) => r.coverageStatus === "gap" || r.coverageStatus === "conflict");
  if (problemRequirements.length === 0) return null;

  const anyInvalidated = problemRequirements.some((r) => r.invalidatedAssignments.length > 0);
  const anyUnresolvable = problemRequirements.some((r) => r.gapResolution && !r.gapResolution.eligible);

  const phase = nowMinutesSinceMidnight !== null ? resolveFlightPhase(view.flight, view.effectiveDeparture, nowMinutesSinceMidnight).phase : null;
  const approachingWindow = phase === "boarding" || phase === "boarding_closing";

  // Section 2's "approaching its operational window with insufficient
  // valid staffing" is this escalation, not a separate alert type: the
  // same unresolved shortage reads as more urgent once boarding has
  // actually started. An invalidation (a previously valid assignment
  // broken by a real flight change, not merely never staffed) is always
  // at least as urgent as an ordinary shortage with the same resolution
  // status.
  const severity: AlertSeverity = anyUnresolvable
    ? approachingWindow || anyInvalidated
      ? "critical"
      : "warning"
    : "info";

  const affectedCount = problemRequirements.reduce((n, r) => n + r.gap, 0);
  const requirementIds = problemRequirements.map((r) => r.requirement.id);

  const detail = problemRequirements
    .map((r) => {
      const bits: string[] = [];
      if (r.invalidatedAssignments.length > 0) bits.push(`${r.invalidatedAssignments.length} invalidated`);
      if (r.gap > 0) bits.push(`gap of ${r.gap}`);
      const resolution = r.gapResolution ? (r.gapResolution.eligible ? "eligible replacement available" : "no eligible employee") : null;
      return `${r.requirement.role}: ${bits.join(", ") || "unresolved"}${resolution ? ` — ${resolution}` : ""}`;
    })
    .join("; ");

  return { kind: anyInvalidated ? "invalidation" : "shortage", severity, requirementIds, affectedCount, detail };
}

function alertTitle(flight: Flight, problem: FlightProblem): string {
  return problem.kind === "invalidation"
    ? `${flight.flight_number} — staffing invalidated by flight change`
    : `${flight.flight_number} — staffing shortage`;
}

/**
 * Recomputes the full alert list for the flights currently in view,
 * reconciling against whatever alert state already exists (see this
 * module's own doc comment for the full lifecycle table). Call this with
 * every fresh LiveOpsView — on initial load, on a date change, and after
 * any save/assign/reassign refresh — exactly where loadLiveOps() already
 * runs; no new refresh mechanism is introduced.
 */
export function reconcileAlerts(
  previous: OperationalAlert[],
  flights: LiveOpsFlightView[],
  nowMinutesSinceMidnight: number | null,
  now: number = Date.now()
): OperationalAlert[] {
  const previousByFlight = new Map(previous.map((a) => [a.flightId, a]));
  const inScope = new Set(flights.map((f) => f.flight.id));
  const result: OperationalAlert[] = [];

  for (const view of flights) {
    const problem = detectFlightProblem(view, nowMinutesSinceMidnight);
    const existing = previousByFlight.get(view.flight.id);

    if (!problem) {
      if (!existing) continue; // never had a problem -- nothing to track
      if (existing.state === "resolved") {
        result.push(existing); // already resolved -- carried forward, not re-resolved every refresh
      } else {
        result.push({ ...existing, state: "resolved", resolvedAt: now, lastSeenAt: now });
      }
      continue;
    }

    if (!existing || existing.state === "resolved") {
      // Brand-new problem, or a genuine reappearance of one that was
      // previously resolved (section 5) -- same stable id, state back to
      // "new", reopenedCount records this is not a first occurrence.
      result.push({
        id: existing?.id ?? `alert-${view.flight.id}`,
        flightId: view.flight.id,
        flightNumber: view.flight.flight_number,
        destination: view.flight.destination,
        kind: problem.kind,
        severity: problem.severity,
        state: "new",
        title: alertTitle(view.flight, problem),
        detail: problem.detail,
        requirementIds: problem.requirementIds,
        affectedCount: problem.affectedCount,
        detectedAt: now,
        lastSeenAt: now,
        acknowledgedAt: undefined,
        resolvedAt: undefined,
        reopenedCount: existing ? existing.reopenedCount + 1 : 0,
      });
      continue;
    }

    // Same ongoing, still-unresolved problem -- refresh content, but
    // deliberately PRESERVE existing.state: acknowledgment must never be
    // silently reset by a routine refresh, and acknowledging is never
    // resolving (section 3).
    result.push({
      ...existing,
      kind: problem.kind,
      severity: problem.severity,
      title: alertTitle(view.flight, problem),
      detail: problem.detail,
      requirementIds: problem.requirementIds,
      affectedCount: problem.affectedCount,
      lastSeenAt: now,
    });
  }

  // Any previous alert for a flight no longer in scope (e.g. the
  // regulator moved to a different date) is simply out of scope here,
  // not "resolved" -- each call to loadLiveOps for a given date owns its
  // own alert set; nothing is silently carried across to a different
  // day's flights.
  void inScope;
  return result;
}

/** Acknowledging only ever moves "new" -> "acknowledged" -- never un-acknowledges, never resolves (section 3). */
export function acknowledgeAlert(alerts: OperationalAlert[], alertId: string, now: number = Date.now()): OperationalAlert[] {
  return alerts.map((a) => (a.id === alertId && a.state === "new" ? { ...a, state: "acknowledged", acknowledgedAt: now } : a));
}

/** Everything still actionable -- "new" and "acknowledged", never "resolved" (section 7: "active problems"). */
export function activeAlerts(alerts: OperationalAlert[]): OperationalAlert[] {
  return alerts.filter((a) => a.state !== "resolved");
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Severity first (critical on top), most-recently-detected within a severity next (section 7: "sorted by severity and urgency"). */
export function sortAlertsForDisplay(alerts: OperationalAlert[]): OperationalAlert[] {
  return [...alerts].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.lastSeenAt - a.lastSeenAt);
}
