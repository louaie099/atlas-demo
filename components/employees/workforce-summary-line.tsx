import { Employee } from "@/lib/types";

interface EnrichedEmployee extends Employee {
  today: { status: "off" | "committed" | "transit" | "on_duty" };
}

export function WorkforceSummaryLine({ employees }: { employees: EnrichedEmployee[] }) {
  const total = employees.length;
  const off = employees.filter((e) => e.today.status === "off").length;
  const unavailable = employees.filter((e) => e.today.status === "committed" || e.today.status === "transit").length;
  const onDuty = total - off - unavailable;
  const multiQualified = employees.filter((e) => e.skills.length > 1).length;

  return (
    <p className="text-sm text-muted">
      {total} Employees · {onDuty} On Duty Today · {off} Off · {unavailable} Committed Elsewhere ·{" "}
      {multiQualified} Multi-qualified
    </p>
  );
}
