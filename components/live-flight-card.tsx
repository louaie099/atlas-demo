import { Employee, Flight } from "@/lib/types";
import { Badge, Button, Card } from "./ui";

export function LiveFlightCard({
  flight,
  assignedEmployees,
  onSimulateDelay,
  simulating,
}: {
  flight: Flight;
  assignedEmployees: Employee[];
  onSimulateDelay: () => void;
  simulating: boolean;
}) {
  const delayed = flight.status === "delayed";

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-ink">
            {flight.flight_number} · {flight.route}
          </h3>
          <p className="text-sm text-muted mt-1">
            Gate {flight.gate} · Boarding {flight.boarding_window_start}–{flight.boarding_window_end} · Departs{" "}
            {flight.scheduled_departure}
          </p>
        </div>
        <Badge tone={delayed ? "warn" : "good"}>{delayed ? "Delayed" : "On schedule"}</Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        {assignedEmployees.map((e) => (
          <span key={e.id} className="text-xs bg-good-50 text-good-700 px-2.5 py-1 rounded-full">
            {e.name} · on position
          </span>
        ))}
      </div>

      <Button variant="secondary" onClick={onSimulateDelay} disabled={simulating || delayed} className="self-start">
        {simulating ? "Simulating…" : delayed ? "Delay already simulated" : "Simulate Flight Delay (+45 min)"}
      </Button>
    </Card>
  );
}
