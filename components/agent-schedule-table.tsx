import { AgentScheduleEntry } from "@/lib/types";
import { Badge, Card } from "./ui";

export function AgentScheduleTable({ schedule }: { schedule: AgentScheduleEntry[] }) {
  return (
    <Card className="p-0 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-muted border-b border-border">
            <th className="px-4 py-3">Employee</th>
            <th className="px-4 py-3">Shift</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Assigned Duties This Week</th>
          </tr>
        </thead>
        <tbody>
          {schedule.map((entry) => (
            <tr key={entry.employee.id} className="border-b border-border last:border-0 align-top">
              <td className="px-4 py-3 font-medium text-ink whitespace-nowrap">{entry.employee.name}</td>
              <td className="px-4 py-3 whitespace-nowrap text-muted">
                {entry.employee.shift_start}–{entry.employee.shift_end}
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <Badge tone={entry.dayOff ? "neutral" : "good"}>
                  {entry.dayOff ? `Off (${entry.employee.off_days.join(", ")})` : "Working"}
                </Badge>
              </td>
              <td className="px-4 py-3">
                {entry.duties.length === 0 && entry.proposedDuties.length === 0 ? (
                  <span className="text-muted">No duties assigned yet</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {entry.duties.map((d, i) => (
                      <span key={`confirmed-${i}`} className="text-xs bg-gray-100 text-ink px-2 py-0.5 rounded-full">
                        {d.dayOfWeek} · {d.flightNumber} · {d.role}
                      </span>
                    ))}
                    {entry.proposedDuties.map((d, i) => (
                      <span
                        key={`proposed-${i}`}
                        className="text-xs bg-warn-50 text-warn-700 px-2 py-0.5 rounded-full border border-warn-500/30"
                      >
                        {d.dayOfWeek} · {d.flightNumber} · {d.role} (proposed)
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
