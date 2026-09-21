import { Flight, RosterRequirementView } from "@/lib/types";
import { PlanIssue } from "@/lib/planning/validation";
import { SummaryMetric } from "./summary-drilldown-sheet";

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
 *  - "Requirements covered" (previously mislabeled "Assigned duties" —
 *    renamed because it was showing a different, smaller number than
 *    Make Planning's own "X duties assigned" result banner and using the
 *    same word "duties" for both, with no way to tell they measure
 *    different things) counts REQUIREMENTS (one row per flight+role slot,
 *    e.g. "AT100 Check-in") that are fully staffed — NOT individual
 *    people. A requirement needing 2 Check-in agents counts as ONE here
 *    once both are found, but as TWO in Make Planning's duty count (which
 *    counts actual persisted employee-to-duty Assignment rows,
 *    headcount-level). Both numbers are correct for what they measure;
 *    they were never meant to match, and are now labeled so a person can
 *    tell why. There is no separate "Confirmed" tile any more: whether a
 *    specific assignment is backed by a real Assignment row or is still
 *    only the engine's own draft-plan duty no longer changes how it's
 *    counted here, since both ARE the plan's assignment (see
 *    RequirementCoverageStatus's doc comment in lib/types.ts).
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
  onSelectMetric,
}: {
  flights: Flight[];
  roster: RosterRequirementView[];
  issues: PlanIssue[];
  // Part 3: each metric is a real drill-down control, not inert text --
  // see summary-drilldown-sheet.tsx and app/planning/page.tsx's own
  // useState for which panel (if any) is open.
  onSelectMetric: (metric: SummaryMetric) => void;
}) {
  const totalFlights = new Set(flights.map((f) => f.id)).size;
  const managedFlights = new Set(roster.map((v) => v.flight.id)).size;

  const requirementsCovered = roster.filter((v) => v.coverageStatus === "assigned").length;
  const gaps = roster.filter((v) => v.coverageStatus === "gap").length;

  const planWarnings = issues.filter(
    (i) =>
      i.type === "rest_violation" ||
      i.type === "weekly_hours_violation" ||
      i.type === "consecutive_off_violation" ||
      i.type === "cross_week_continuity_uncertain" ||
      i.type === "separated_off_days"
  ).length;

  // Ordered by draft-plan priority, not raw category: Flights sets the
  // scale, Managed flights narrows it to what ATLAS actually plans for,
  // Requirements covered comes next because a full spread of ATLAS
  // coverage IS the successful outcome of a draft generation -- not a
  // fallback awaiting approval. Staffing gaps and Plan warnings follow.
  const stats: { label: string; value: number; dot: string; hint?: string; metric: SummaryMetric }[] = [
    { label: "Flights this week", value: totalFlights, dot: "bg-gray-400", hint: "Every scheduled flight, managed or not — click to view in Flight Schedule", metric: "flights" },
    { label: "Managed flights", value: managedFlights, dot: "bg-gray-600", hint: "Flights ATLAS generates staffing coverage for — click to view them", metric: "managed" },
    {
      label: "Requirements covered",
      value: requirementsCovered,
      dot: "bg-brand-500",
      hint: "Flight+role slots fully staffed by this draft plan (a slot needing 2 people still counts as one covered slot here — see Make Planning's own duty count for the individual-person total) — click to view",
      metric: "covered",
    },
    { label: "Staffing gaps", value: gaps, dot: "bg-bad-500", hint: "Not enough valid people found -- may warrant a renfort decision — click to view and Find Agent", metric: "gaps" },
    { label: "Plan warnings", value: planWarnings, dot: "bg-warn-700", hint: "Rest, weekly-hours, consecutive-OFF, separated-OFF-days, or unconfirmed cross-week continuity issues in this week's plan — click to view", metric: "warnings" },
  ];

  return (
    <div className="flex flex-wrap gap-x-2 gap-y-2 bg-white border border-border rounded-xl2 px-2 py-2 shadow-soft text-sm">
      {stats.map((s) => (
        <button
          key={s.label}
          type="button"
          title={s.hint}
          onClick={() => onSelectMetric(s.metric)}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-brand-500"
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} />
          <span className="text-muted">{s.label}</span>
          <span className="font-semibold text-ink">{s.value}</span>
        </button>
      ))}
    </div>
  );
}
