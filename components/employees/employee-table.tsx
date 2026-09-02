import { Employee } from "@/lib/types";
import { Badge } from "@/components/ui";
import { TeamBadge } from "@/components/team-badge";
import { getTeamColor } from "@/lib/team-colors";

interface EnrichedEmployee extends Employee {
  today: {
    status: "off" | "committed" | "transit" | "on_duty";
    shiftCode: string | null;
    foreignCommitment: { airline: string } | null;
  };
}

const statusLabel: Record<string, string> = {
  on_duty: "On Duty",
  off: "Off",
  transit: "Transit",
  committed: "Committed",
};

const statusTone: Record<string, "good" | "neutral" | "warn"> = {
  on_duty: "good",
  off: "neutral",
  transit: "warn",
  committed: "warn",
};

export function EmployeeTable({
  employees,
  onSelect,
}: {
  employees: EnrichedEmployee[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="bg-card border border-border rounded-xl2 shadow-soft overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-muted border-b border-border">
            <th className="px-4 py-3">Employee</th>
            <th className="px-4 py-3">Team</th>
            <th className="px-4 py-3">Shift Today</th>
            <th className="px-4 py-3">Qualifications</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Weekly Hours</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => (
            <tr
              key={e.id}
              onClick={() => onSelect(e.id)}
              className="border-b border-border last:border-0 cursor-pointer hover:bg-surface"
            >
              <td className="px-4 py-3 font-medium text-ink whitespace-nowrap">
                <div className="flex items-center gap-2">
                  {e.name}
                  {e.is_duty_officer && <Badge tone="brand">Duty Officer</Badge>}
                </div>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <TeamBadge name={e.assignment} />
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-muted">
                {e.today.shiftCode ?? (e.today.status === "off" ? "—" : e.shift_code ?? "custom")}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {e.skills.slice(0, 3).map((s) => (
                    <span key={s} className="text-xs bg-gray-100 text-ink px-2 py-0.5 rounded-full">
                      {s}
                    </span>
                  ))}
                  {e.skills.length > 3 && <span className="text-xs text-muted">+{e.skills.length - 3}</span>}
                </div>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <Badge tone={statusTone[e.today.status]}>
                  {e.today.status === "committed" && e.today.foreignCommitment ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: getTeamColor(e.today.foreignCommitment.airline) }}
                      />
                      Committed · {e.today.foreignCommitment.airline}
                    </span>
                  ) : (
                    statusLabel[e.today.status]
                  )}
                </Badge>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <Badge tone={e.weekly_hours >= 35 ? "warn" : "neutral"}>{e.weekly_hours}h</Badge>
              </td>
            </tr>
          ))}
          {employees.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-muted">
                No employees match these filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
