import { RosterRequirementView } from "@/lib/types";
import { Badge, Button, Card } from "./ui";

const statusTone = {
  covered: "good",
  proposed: "warn",
  gap: "bad",
  conflict: "bad",
  needs_configuration: "warn",
} as const;

const statusLabel = {
  covered: "Covered",
  proposed: "Proposed (draft)",
  gap: "Gap",
  conflict: "Conflict",
  needs_configuration: "Needs Configuration",
} as const;

export function FlightCoverageCard({
  view,
  onFindAgent,
}: {
  view: RosterRequirementView;
  onFindAgent: (requirementId: string) => void;
}) {
  const { requirement, flight, assignedEmployees, proposedEmployees, coverageStatus } = view;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-muted">{flight.scheduled_departure}</span>
            <h3 className="text-base font-semibold text-ink">
              {flight.flight_number} · {flight.route}
            </h3>
            <Badge tone={flight.operator_type === "atlas_managed" ? "brand" : "neutral"}>
              {flight.operator_type === "atlas_managed" ? "Atlas-Managed" : "Self-Managed"}
            </Badge>
          </div>
          <p className="text-sm text-muted mt-1">
            {flight.airline} · {flight.aircraft}
            {flight.destination_category ? ` · ${flight.destination_category}` : ""}
          </p>
        </div>
        <Badge tone={statusTone[coverageStatus]}>{statusLabel[coverageStatus]}</Badge>
      </div>

      <div className="text-sm bg-surface rounded-lg px-3 py-2">
        <span className="font-medium text-ink">{requirement.role}</span>
        {!requirement.needs_configuration && (
          <span className="text-muted">
            {" "}
            — {assignedEmployees.length + proposedEmployees.length}/{requirement.total_requirement}
            {proposedEmployees.length > 0 && ` (${assignedEmployees.length} confirmed + ${proposedEmployees.length} proposed)`}
            {requirement.source === "demand_forecast" &&
              ` (baseline ${requirement.baseline_requirement} + reinforcement ${requirement.additional_requirement})`}
          </span>
        )}
        <p className="text-muted mt-1">{requirement.reasoning}</p>
      </div>

      {!requirement.needs_configuration && (
        <div className="flex flex-wrap gap-2">
          {assignedEmployees.map((e) => (
            <span key={e.id} className="text-xs bg-gray-100 text-ink px-2.5 py-1 rounded-full">
              {e.name}
            </span>
          ))}
          {proposedEmployees.map((e) => (
            <span key={e.id} className="text-xs bg-warn-50 text-warn-700 px-2.5 py-1 rounded-full border border-warn-500/30">
              {e.name} (proposed)
            </span>
          ))}
          {assignedEmployees.length === 0 && proposedEmployees.length === 0 && (
            <span className="text-xs text-muted">No one assigned yet</span>
          )}
        </div>
      )}

      {coverageStatus === "gap" && (
        <Button onClick={() => onFindAgent(requirement.id)} className="self-start">
          Find Agent
        </Button>
      )}
    </Card>
  );
}
