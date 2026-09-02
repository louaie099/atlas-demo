import { RosterRequirementView } from "@/lib/types";
import { Badge, Button, Card } from "./ui";

export function RosterCard({
  view,
  onFindAgent,
}: {
  view: RosterRequirementView;
  onFindAgent: (requirementId: string) => void;
}) {
  const { requirement, flight, assignedEmployees, gap } = view;
  const covered = gap <= 0;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-ink">
              {flight.flight_number} · {requirement.role}
            </h3>
            <Badge tone={requirement.source === "fixed_rule" ? "brand" : "warn"}>
              {requirement.source === "fixed_rule" ? "Fixed Rule" : "Planning Forecast"}
            </Badge>
          </div>
          <p className="text-sm text-muted mt-1">
            {flight.route} · {flight.aircraft} · departs {flight.scheduled_departure}
          </p>
        </div>
        <Badge tone={covered ? "good" : "bad"}>
          {assignedEmployees.length} / {requirement.total_requirement}
        </Badge>
      </div>

      {requirement.source === "demand_forecast" && (
        <div className="text-sm bg-warn-50 text-warn-700 rounded-lg px-3 py-2">
          Baseline {requirement.baseline_requirement} + reinforcement {requirement.additional_requirement} ={" "}
          {requirement.total_requirement}. {requirement.reasoning}
        </div>
      )}
      {requirement.source === "fixed_rule" && (
        <div className="text-sm text-muted">{requirement.reasoning}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {assignedEmployees.map((e) => (
          <span key={e.id} className="text-xs bg-gray-100 text-ink px-2.5 py-1 rounded-full">
            {e.name}
          </span>
        ))}
        {assignedEmployees.length === 0 && <span className="text-xs text-muted">No one assigned yet</span>}
      </div>

      {!covered && (
        <Button onClick={() => onFindAgent(requirement.id)} className="self-start">
          Find Agent
        </Button>
      )}
    </Card>
  );
}
