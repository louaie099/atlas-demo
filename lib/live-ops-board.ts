import { LiveOpsFlightView } from "./live-ops-service";
import { LiveOpsFlightState } from "./live-ops-flight-state";
import { resolveFlightPhase } from "./flight-phase";

/**
 * Exception-based board grouping (Live Operations redesign section 4):
 * NEEDS ATTENTION -> UPCOMING/ACTIVE -> NORMAL -> COMPLETED. Built purely
 * from state/phase data every caller already computes per flight — this
 * never re-derives either, so the board's grouping can never disagree
 * with a row's own badge/dot.
 */
export type BoardSection = "needsAttention" | "upcomingActive" | "normal" | "completed";

export const BOARD_SECTION_LABEL: Record<BoardSection, string> = {
  needsAttention: "Needs Attention",
  upcomingActive: "Upcoming / Active",
  normal: "Normal",
  completed: "Completed",
};

export function sectionFor(
  view: LiveOpsFlightView,
  state: LiveOpsFlightState,
  nowMinutesSinceMidnight: number | null
): BoardSection {
  if (state === "conflict" || state === "gap") return "needsAttention";

  const resolved = resolveFlightPhase(view.flight, view.effectiveDeparture, nowMinutesSinceMidnight ?? 0);
  const departed = (nowMinutesSinceMidnight !== null || resolved.isManualOverride) && resolved.phase === "departed";
  if (departed) return "completed";

  if (state === "delayed") return "upcomingActive";

  // "Active" window: boarding has started but the flight hasn't departed.
  // A flight not yet in that window (and otherwise covered/on time) is
  // simply Normal — the quiet, nothing-to-watch state the spec asks for.
  if (nowMinutesSinceMidnight !== null && (resolved.phase === "boarding" || resolved.phase === "boarding_closing")) {
    return "upcomingActive";
  }

  return "normal";
}

export function groupFlights(
  flights: LiveOpsFlightView[],
  stateFor: (view: LiveOpsFlightView) => LiveOpsFlightState,
  nowMinutesSinceMidnight: number | null
): Record<BoardSection, LiveOpsFlightView[]> {
  const groups: Record<BoardSection, LiveOpsFlightView[]> = {
    needsAttention: [],
    upcomingActive: [],
    normal: [],
    completed: [],
  };
  for (const view of flights) {
    const state = stateFor(view);
    groups[sectionFor(view, state, nowMinutesSinceMidnight)].push(view);
  }
  return groups;
}
