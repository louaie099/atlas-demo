import { Flight } from "./types";
import { LiveOpsImpact } from "./live-ops-service";

/**
 * Live Operations' Notification/Attention Center (redesign section 7) —
 * deliberately an IN-MEMORY, CLIENT-SIDE-ONLY model for this pass: no new
 * database table, no migration, nothing persisted across a page reload.
 * This is a stated scope decision, not an oversight (see
 * APPLY_NOTES_0093 "WHAT'S DELIBERATELY LEFT IN PLACE" for the full
 * reasoning) — every notification is reconstructible at any time from the
 * same evaluate-impact call that produced it, so nothing is lost that the
 * live /api/live-ops data can't regenerate on demand; what IS lost on
 * reload is purely the read/unread/acknowledged UI state, which is
 * acceptable for a demo-focused pass.
 */
export type NotificationSeverity = "info" | "warning" | "critical";
export type NotificationState = "new" | "acknowledged" | "resolved";

export interface LiveOpsNotification {
  id: string;
  severity: NotificationSeverity;
  state: NotificationState;
  flightId: string;
  flightNumber: string;
  title: string;
  detail: string;
  /** Staffing requirement ids this notification is about, for a "View" click to focus the right drawer section. */
  requirementIds: string[];
  createdAt: number;
}

let notificationSeq = 0;

/**
 * Builds ONE aggregated notification from an evaluate-impact result
 * (section 7's explicit ask: "AT815 delay created 4 staffing conflicts
 * rather than four simultaneous repetitive notifications"). Returns null
 * when the impact carries no conflicts — callers should simply not
 * notify in that case, never emit an empty/info-only placeholder.
 */
export function buildDelayImpactNotification(flight: Flight, impact: LiveOpsImpact): LiveOpsNotification | null {
  if (impact.conflicts.length === 0) return null;

  const anyUnfilled = impact.conflicts.some((c) => c.replacementCandidates.length === 0);
  const roles = Array.from(new Set(impact.conflicts.map((c) => c.requirement.role)));

  notificationSeq += 1;
  return {
    id: `notif-${Date.now()}-${notificationSeq}`,
    severity: anyUnfilled ? "critical" : "warning",
    state: "new",
    flightId: flight.id,
    flightNumber: flight.flight_number,
    title: `${flight.flight_number} staffing impact`,
    detail: `Delay created ${impact.conflicts.length} assignment conflict${impact.conflicts.length > 1 ? "s" : ""} (${roles.join(", ")}).`,
    requirementIds: impact.conflicts.map((c) => c.requirement.id),
    createdAt: Date.now(),
  };
}

export const NOTIFICATION_SEVERITY_LABEL: Record<NotificationSeverity, string> = {
  info: "Info",
  warning: "Warning",
  critical: "Critical",
};
