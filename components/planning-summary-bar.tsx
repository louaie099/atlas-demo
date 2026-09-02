import { RosterRequirementView } from "@/lib/types";

export function PlanningSummaryBar({ roster }: { roster: RosterRequirementView[] }) {
  const total = roster.length;
  const covered = roster.filter((v) => v.coverageStatus === "covered").length;
  // "proposed" is its own honest bucket — covered only with the help of
  // the engine's draft plan, never lumped into "covered" (that would
  // silently present a suggestion as human-confirmed) or dropped from the
  // counts entirely (which is what happened here before this fix: this
  // filter list didn't include "proposed" at all, so those requirements
  // vanished from every bucket except the "Flights" total).
  const proposed = roster.filter((v) => v.coverageStatus === "proposed").length;
  const gaps = roster.filter((v) => v.coverageStatus === "gap").length;
  const needsConfig = roster.filter((v) => v.coverageStatus === "needs_configuration").length;
  const conflicts = roster.filter((v) => v.coverageStatus === "conflict").length;

  const stats: { label: string; value: number; dot: string }[] = [
    { label: "Flights", value: total, dot: "bg-gray-400" },
    { label: "Covered", value: covered, dot: "bg-good-500" },
    { label: "Proposed (draft)", value: proposed, dot: "bg-warn-500" },
    { label: "Gaps", value: gaps, dot: "bg-bad-500" },
    { label: "Conflicts", value: conflicts, dot: "bg-bad-700" },
    { label: "Needs Configuration", value: needsConfig, dot: "bg-warn-500" },
  ];

  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 bg-white border border-border rounded-xl2 px-4 py-3 shadow-soft text-sm">
      {stats.map((s) => (
        <div key={s.label} className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${s.dot}`} />
          <span className="text-muted">{s.label}</span>
          <span className="font-semibold text-ink">{s.value}</span>
        </div>
      ))}
    </div>
  );
}
