"use client";

import { LiveOpsFlightView } from "@/lib/live-ops-service";
import { FLIGHT_STATE_LABEL, LiveOpsFlightState } from "@/lib/live-ops-flight-state";
import { Badge, Button } from "./ui";
import { TeamBadge } from "./team-badge";

// Reuses Flight Coverage's own status-to-tone convention
// (components/flight-coverage-card.tsx's statusTone) for per-requirement
// chips, so a requirement reads the same way in Monthly Planning and here.
const requirementTone = {
  assigned: "good",
  gap: "bad",
  conflict: "bad",
} as const;

const stateTone: Record<LiveOpsFlightState, "good" | "warn" | "bad" | "neutral"> = {
  covered: "good",
  delayed: "warn",
  gap: "bad",
  conflict: "bad",
};

/**
 * One flight's compact Live Operations row. Calm/muted when fully covered
 * and on time (no badge at all -- nothing here needs attention); a visible
 * accent only appears for a flight that actually needs a look
 * (Gap/Delayed/Conflict), per the product's "scan-and-act, not a
 * dashboard" brief.
 */
export function FlightOpsRow({
  view,
  state,
  onEdit,
}: {
  view: LiveOpsFlightView;
  state: LiveOpsFlightState;
  onEdit: () => void;
}) {
  const { flight, effectiveDeparture, requirements } = view;
  const departureChanged = effectiveDeparture !== flight.scheduled_departure;
  const calm = state === "covered";

  return (
    <div
      className={`bg-card border rounded-xl2 shadow-soft overflow-hidden ${
        calm ? "border-border" : "border-bad-500/30"
      }`}
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-semibold text-ink">{flight.flight_number}</span>
          <span className="text-sm text-ink">{flight.destination ?? flight.route}</span>
          <TeamBadge name={flight.airline} />
          <span className="text-xs text-muted">{flight.aircraft}</span>

          <span className="text-xs text-muted">
            Scheduled {flight.scheduled_departure}
            {departureChanged && (
              <span className="ml-1.5 font-medium text-warn-700">· Current {effectiveDeparture}</span>
            )}
          </span>

          {flight.gate && <span className="text-xs text-muted">Gate {flight.gate}</span>}

          {!calm && <Badge tone={stateTone[state]}>{FLIGHT_STATE_LABEL[state]}</Badge>}

          <Button variant="ghost" className="ml-auto !px-2 !py-1 !shadow-none" onClick={onEdit}>
            Edit flight
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          {requirements.map((r) => (
            <div
              key={r.requirement.id}
              className="flex items-center justify-between gap-3 text-sm rounded-lg bg-surface px-3 py-1.5"
            >
              <span className="text-ink">
                {r.coverageLabel}{" "}
                <span className="text-muted">
                  {r.assignedEmployees.length}/{r.requirement.total_requirement}
                </span>
              </span>
              <div className="flex items-center gap-2 flex-wrap justify-end">
                {r.assignedEmployees.length > 0 ? (
                  r.assignedEmployees.map((e) => (
                    <span key={e.id} className="text-xs bg-gray-100 text-ink px-2 py-0.5 rounded-full">
                      {e.name}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-muted">— gap —</span>
                )}
                <Badge tone={requirementTone[r.coverageStatus]}>{r.coverageStatus}</Badge>
              </div>
            </div>
          ))}
          {requirements.length === 0 && <p className="text-xs text-muted">No staffing requirements for this flight.</p>}
        </div>
      </div>
    </div>
  );
}
