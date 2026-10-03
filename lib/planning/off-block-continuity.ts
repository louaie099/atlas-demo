import { Employee, WeeklyPlanRosterEntry } from "../types";
import { deriveTransitionContextFromPriorPlan, previousWeekStart } from "./rotation-context";
import { isGenerationDrivenPopulation } from "./workforce-pools";
import { usesFixedCycleRotation } from "../teams";

/**
 * OFF/OFF BLOCK BOUNDARY CONTINUITY (Planning Rules milestone — "do not
 * reset the roster on Monday"). The ONE missing piece of cross-week
 * continuity this module exists for: rest (rotation-context.ts), fatigue
 * (fatigue-continuity.ts) and the consecutive-work-day cap
 * (consecutive-days-continuity.ts) already carry real state across the
 * Sunday(week N) -> Monday(week N+1) boundary. Nothing did the same for a
 * generation-driven employee's weekly OFF/OFF recovery BLOCK: if the
 * immediately preceding week's real last day (Sunday) was the FIRST of
 * what should be a 2-day consecutive OFF block, this week's Monday must
 * continue it -- rather than Stage 6 (or the specialized generators)
 * independently choosing Monday as WORK and leaving Sunday an isolated,
 * orphaned single OFF day.
 *
 * Mirrors fatigue-continuity.ts / consecutive-days-continuity.ts's own
 * doc-comment shape and reads the SAME rotation-context.ts primitive
 * (deriveTransitionContextFromPriorPlan) those modules already use for
 * each prior-week day, rather than a new Supabase query pattern or a new
 * roster-reading mechanism.
 *
 * ONE DELIBERATE DIFFERENCE from those two modules: there is no
 * "fallback_static_baseline" outcome here. A static weekly_shifts baseline
 * has no notion of "which day of a recurring OFF/OFF block this is" (it is
 * a flat template, not a dated history), and — exactly as those modules
 * already establish — a static baseline is never authoritative for a
 * DEMAND-DRIVEN (generation-driven) employee in the first place, which is
 * the only population this boundary rule ever applies to (fixed-cycle
 * JR/NT/OFF/OFF teams are excluded below — their continuous cycle already
 * does not reset at boundaries, by construction). So the only two honest
 * outcomes are a REAL published predecessor plan, or genuinely unknown.
 *
 * PUBLISHED-ONLY, DELIBERATELY: unlike rotation-context.ts's rest-boundary
 * seed (which also accepts a draft predecessor — out of scope to change
 * here), this module must only ever be fed a PUBLISHED prior week's
 * roster. A draft can still be edited or discarded before anyone commits
 * to it, so completing a "must be OFF Monday" obligation sourced from a
 * draft would commit week N+1 to a week N shape that might never actually
 * ship that way. The caller (weekly-plan-service.ts) is responsible for
 * only ever passing `kind: "prior_published_plan"` when the predecessor's
 * `status` is actually "published" — this module trusts that contract
 * rather than re-deriving it (it has no access to a plan's status, only
 * its roster rows).
 */

/**
 * The relationship between the prior week's real last two days and a 2-day
 * OFF/OFF recovery block, from this week's Monday perspective:
 *
 *   - "requires_first_day_off": the prior week's LAST day (e.g. Sunday) was
 *     OFF and the day before it (e.g. Saturday) was WORKED -- Sunday is the
 *     FIRST day of a block that is not yet complete. This week's first day
 *     (Monday) MUST be OFF to complete it.
 *   - "satisfied": the prior week's last two days were BOTH OFF -- the
 *     block already completed entirely within the prior week (Sunday was
 *     its SECOND/final day). This week's Monday carries no obligation; it
 *     is free to be chosen like any other day.
 *   - "none": the prior week's last day was WORKED -- no OFF block is open
 *     at the boundary at all.
 */
export type OffBlockEdgeKind = "requires_first_day_off" | "satisfied" | "none";

export type IncomingOffBlockState =
  | { source: "prior_plan"; kind: OffBlockEdgeKind }
  | { source: "unknown"; kind: "none"; reason: string };

/**
 * `priorPlanRosterEntries` must be the full roster of the immediately
 * preceding week's PUBLISHED plan (see this module's doc comment on why
 * published-only) -- the same full-week fetch rotation-context.ts's own
 * callers already do (fetchAllRosterEntriesForPlan), never a narrower
 * last-day-only query, since this derivation needs the prior week's LAST
 * TWO days to tell "first day of a new block" apart from "second day of an
 * already-complete one".
 */
export type OffBlockSeedInput =
  | {
      kind: "prior_published_plan";
      priorPlanRosterEntries: WeeklyPlanRosterEntry[];
      /** The Monday of the week being SEEDED (the upcoming week) -- the prior plan's week is previousWeekStart(this). */
      weekStart: string;
      daysOrder: string[];
    }
  | { kind: "none" };

/**
 * The OFF/OFF block boundary state `employee` carries into the week
 * described by `input`. See this module's doc comment for the outcomes.
 */
export function deriveIncomingOffBlockState(employee: Employee, input: OffBlockSeedInput): IncomingOffBlockState {
  if (input.kind === "none") {
    return { source: "unknown", kind: "none", reason: "No published predecessor plan available (first-ever week, or the prior week is still a draft)." };
  }

  // Fixed-cycle JR/NT/OFF/OFF teams (Transit/Leaders/Duty Officers) never
  // reset at a displayed-week boundary -- their continuous cycle already
  // carries forward by construction (fixed-cycle-rotation.ts) -- and a
  // static/still-template team outside isGenerationDrivenPopulation has no
  // generation-time OFF/OFF block to continue in the first place. This is
  // a no-op confirmation, not new logic: neither population is ever a
  // candidate for the window search this state feeds.
  if (usesFixedCycleRotation(employee.assignment) || !isGenerationDrivenPopulation(employee)) {
    return { source: "unknown", kind: "none", reason: "Not a generation-driven population -- a fixed-cycle or static rotation governs this employee instead." };
  }

  const { daysOrder, weekStart, priorPlanRosterEntries } = input;
  if (daysOrder.length < 2) {
    return { source: "unknown", kind: "none", reason: "Window too short to resolve a trailing 2-day OFF block." };
  }
  if (!priorPlanRosterEntries.some((r) => r.employee_id === employee.id)) {
    // Mirrors fatigue-continuity.ts / consecutive-days-continuity.ts: a
    // missing row across the WHOLE predecessor plan means no history, not
    // a week of OFF days.
    return { source: "unknown", kind: "none", reason: "Employee has no roster rows in the predecessor plan." };
  }

  const priorWeekStart = previousWeekStart(weekStart);
  const lastDay = daysOrder[daysOrder.length - 1];
  const secondLastDay = daysOrder[daysOrder.length - 2];
  const lastDayWorked = deriveTransitionContextFromPriorPlan([employee], priorPlanRosterEntries, lastDay, priorWeekStart).get(employee.id) != null;
  const secondLastDayWorked = deriveTransitionContextFromPriorPlan([employee], priorPlanRosterEntries, secondLastDay, priorWeekStart).get(employee.id) != null;

  if (lastDayWorked) {
    // The prior week's real last day was worked -- no OFF block is open at
    // the boundary at all.
    return { source: "prior_plan", kind: "none" };
  }
  if (secondLastDayWorked) {
    // Worked, then OFF: the last day is the FIRST (incomplete) day of a
    // 2-day block -- this week's first day must complete it.
    return { source: "prior_plan", kind: "requires_first_day_off" };
  }
  // OFF, then OFF: the block already completed within the prior week.
  return { source: "prior_plan", kind: "satisfied" };
}
