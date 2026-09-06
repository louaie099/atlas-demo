import { Flight, RosterRequirementView } from "@/lib/types";
import { PlanIssue } from "@/lib/planning/validation";

/**
 * Every number here is derivable from THIS WEEK'S real data — nothing is
 * added just to fill the bar, and nothing stays that no longer means what
 * its label says.
 *
 *  - "Flights this week" = every scheduled flight (`flights`, the same raw
 *    array Flight Schedule renders), managed or not.
 *  - "Managed flights" = the subset of those flights ATLAS actually
 *    generates Flight Coverage for (i.e. appear at least once in
 *    `roster`). The gap between this and "Flights this week" is exactly
 *    the unmanaged/unconfigured flights that stay Flight-Schedule-only —
 *    a real, useful number, not hidden.
 *  - "Assigned duties" is the NORMAL successful state of a draft plan, not
 *    a pending recommendation. There is no separate "Confirmed" tile any
 *    more: whether a specific assignment is backed by a real Assignment
 *    row or is still only the engine's own draft-plan duty no longer
 *    changes how it's counted here, since both ARE the plan's assignment
 *    (see RequirementCoverageStatus's doc comment in lib/types.ts).
 *  - "Staffing gaps" = requirements the draft plan could not fully cover —
 *    the one bucket that may warrant a human renfort decision.
 *  - "Plan warnings" = genuine OPERATIONAL problems in this week's
 *    generated plan only: rest violations, weekly-hours violations,
 *    consecutive-OFF violations. A missing internal RAM configuration rule
 *    is a DIFFERENT concept (see lib/planning/validation.ts's
 *    ConfigurationIssue) and deliberately does not appear here at all —
 *    it's an administrative gap, not a planning-quality problem, and
 *    belongs in a future Administration/Configuration area instead.
 *
 * The dead "Conflict" and "Confirmed" counters are gone entirely —
 * computeCoverageStatus documents that conflict never applies to a
 * static draft plan (it's a Live Operations concept), and the
 * confirmed/assigned distinction is no longer the headline story for
 * ordinary staffing (see above).
 */
export function PlanningSummaryBar({
  flights,
  roster,
  issues,
}: {
  flights: Flight[];
  roster: RosterRequirementView[];
  issues: PlanIssue[];
}) {
  const totalFlights = new Set(flights.map((f) => f.id)).size;
  const managedFlights = new Set(roster.map((v) => v.flight.id)).size;

  const assigned = roster.filter((v) => v.coverageStatus === "assigned").length;
  const gaps = roster.filter((v) => v.coverageStatus === "gap").length;

  const planWarnings = issues.filter(
    (i) => i.type === "rest_violation" || i.type === "weekly_hours_violation" || i.type === "consecutive_off_violation"
  ).length;

  // Ordered by draft-plan priority, not raw category: Flights sets the
  // scale, Managed flights narrows it to what ATLAS actually plans for,
  // Assigned duties comes next because a full spread of ATLAS assignments
  // IS the successful outcome of a draft generation -- not a fallback
  // awaiting approval. Staffing gaps and Plan warnings follow.
  const stats: { label: string; value: number; dot: string; hint?: string }[] = [
    { label: "Flights this week", value: totalFlights, dot: "bg-gray-400", hint: "Every scheduled flight, managed or not" },
    { label: "Managed flights", value: managedFlights, dot: "bg-gray-600", hint: "Flights ATLAS generates staffing coverage for" },
    { label: "Assigned duties", value: assigned, dot: "bg-brand-500", hint: "Staffed by this draft plan" },
    { label: "Staffing gaps", value: gaps, dot: "bg-bad-500", hint: "Not enough valid people found -- may warrant a renfort decision" },
    { label: "Plan warnings", value: planWarnings, dot: "bg-warn-700", hint: "Rest, weekly-hours, or consecutive-OFF issues in this week's plan" },
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
