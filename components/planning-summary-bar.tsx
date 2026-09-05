import { RosterRequirementView } from "@/lib/types";
import { PlanIssue } from "@/lib/planning/validation";

/**
 * Redesigned around draft-plan semantics, not a generic "status counter"
 * bar. Two things this deliberately gets right that the old version
 * didn't:
 *
 *  - "Proposed" is the NORMAL successful state of a draft plan, not a
 *    warning -- it's shown with a calm/positive dot, ordered ahead of
 *    Confirmed (which is expected to be near-zero pre-publish and would
 *    otherwise read as "ATLAS failed" if led with).
 *  - "Needs Configuration" is counted from `roster` (a real, distinct
 *    coverage status -- never conflated with "Gaps", which is a genuine
 *    staffing shortfall). "Plan Warnings" is a SEPARATE bucket sourced
 *    from `issues` (rest/weekly-hours violations) -- information the
 *    per-requirement roster view has no way to carry, since a violation
 *    belongs to an employee/day, not a requirement.
 *
 * The dead "Conflict" counter is gone entirely -- computeCoverageStatus
 * documents that conflict never applies to a static draft plan (it's a
 * Live Operations concept), so it was always reading 0.
 */
export function PlanningSummaryBar({
  roster,
  issues,
}: {
  roster: RosterRequirementView[];
  issues: PlanIssue[];
}) {
  const flights = new Set(roster.map((v) => v.flight.id)).size;

  const proposed = roster.filter((v) => v.coverageStatus === "proposed").length;
  const covered = roster.filter((v) => v.coverageStatus === "covered").length;
  const gaps = roster.filter((v) => v.coverageStatus === "gap").length;
  const needsConfig = roster.filter((v) => v.coverageStatus === "needs_configuration").length;

  const planWarnings = issues.filter(
    (i) => i.type === "rest_violation" || i.type === "weekly_hours_violation"
  ).length;

  // Ordered by draft-plan priority, not raw category: Flights sets the scale,
  // Proposed comes right after it because a full spread of ATLAS proposals IS
  // the successful outcome of a draft generation -- not a fallback. Gaps and
  // Needs Configuration (both "needs attention" buckets) follow, then Plan
  // warnings. Confirmed is real and still shown, but pre-publish it's expected
  // to be near-zero, so it's deliberately placed last rather than up front
  // where a low number would misread as "the plan barely worked."
  const stats: { label: string; value: number; dot: string; hint?: string }[] = [
    { label: "Flights this week", value: flights, dot: "bg-gray-400" },
    { label: "Proposed by ATLAS", value: proposed, dot: "bg-brand-500", hint: "Draft coverage -- not yet published" },
    { label: "Staffing gaps", value: gaps, dot: "bg-bad-500", hint: "Not enough valid people found" },
    { label: "Needs configuration", value: needsConfig, dot: "bg-warn-500", hint: "A rule or agreement isn't set up yet" },
    { label: "Plan warnings", value: planWarnings, dot: "bg-warn-700", hint: "Rest or weekly-hours issues in the roster" },
    { label: "Confirmed", value: covered, dot: "bg-good-500", hint: "Human-confirmed assignments" },
  ];

  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 bg-white border border-border rounded-xl2 px-4 py-3 shadow-soft text-sm">
      {stats.map((s) => (
        <div key={s.label} className="flex items-center gap-2" title={s.hint}>
          <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} />
          <span className="text-muted">{s.label}</span>
          <span className="font-semibold text-ink">{s.value}</span>
        </div>
      ))}
    </div>
  );
}
