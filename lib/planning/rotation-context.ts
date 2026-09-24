import { Employee, WeeklyPlanRosterEntry } from "../types";
import { PriorDayShiftMap } from "./shift-generation";
import { effectiveShiftForDay } from "./duty-generation";
import { getShiftTimesAs } from "../shift-templates";
import { flightDateFor, shiftWeek } from "../flight-date";

/**
 * Cross-week continuity primitives (Task D). The core idea this file
 * exists for: a displayed Monday-Sunday WeeklyPlan is a VIEW/PLANNING
 * SLICE, not the boundary of an employee's actual continuous work/OFF
 * rotation (see generate-draft-plan.ts's priorWeekBoundaryContext
 * parameter and the delivered report). This week's Monday must be
 * rest-checked against whatever the employee ACTUALLY worked the day
 * before -- the immediately preceding WeeklyPlan's real Sunday roster,
 * when one exists.
 *
 * This is deliberately the SMALL, honest piece of that architecture: it
 * derives a `PriorDayShiftMap` boundary seed two ways (from a real prior
 * plan, or a same-baseline fallback when none exists yet) and computes
 * which calendar week precedes a given one. It does NOT implement a
 * general rotation-anchor/phase engine, and it does NOT change how a
 * normal employee's work/OFF pattern is chosen within a week -- per the
 * explicit instruction not to redesign the whole planning optimizer in
 * this pass, and not to hardcode any particular rotation shape. A future
 * milestone that drives normal-employee OFF-day placement from
 * multi-week RAM demand can build on top of this boundary primitive
 * without redoing it.
 */

/**
 * Where a week's cross-week boundary context came from — the honest
 * three-way distinction every consumer of continuity data must respect:
 *
 *  - "prior_plan": derived from a REAL, persisted immediately-preceding
 *    WeeklyPlan (deriveTransitionContextFromPriorPlan) — genuine history.
 *  - "fallback_static_baseline": no predecessor plan; stood in by each
 *    employee's own static weekly_shifts baseline
 *    (deriveFallbackBoundaryContext) — a documented approximation. For the
 *    demand-driven flexible pool this yields `null` for everyone purely for
 *    lack of data, which must NOT be read as "was really OFF".
 *  - "unknown": nothing at all is known (e.g. a caller passed no context).
 */
export type BoundaryContextProvenance = "prior_plan" | "fallback_static_baseline" | "unknown";

/**
 * The calendar date (YYYY-MM-DD) seven days before `weekStart` -- i.e.
 * the start of the immediately preceding displayed week, assuming every
 * WeeklyPlan covers a fixed 7-day span (true for every plan this demo
 * generates today). Pure date arithmetic in UTC to avoid local-timezone
 * off-by-one-day bugs.
 */
export function previousWeekStart(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Builds the cross-plan Sunday(week N) -> Monday(week N+1) continuity
 * seed from an immediately preceding, ALREADY-PERSISTED plan's real last
 * displayed day roster -- never from that plan's employees' static
 * baseline, since the whole point is capturing what Stage 6 (or a fixed
 * cycle's own continuous logic) actually put on the roster last week, not
 * what an employee's template says.
 *
 * A missing roster row, an "off" status, or a null shift_code all
 * correctly become `null` in the map (never "no data" -- see
 * PriorDayShiftMap's own doc comment on the null/undefined distinction)
 * so the forward rest gate is properly skipped for that employee, exactly
 * as it would be for a real OFF day.
 */
export function deriveTransitionContextFromPriorPlan(
  employees: Employee[],
  priorPlanRosterEntries: WeeklyPlanRosterEntry[],
  priorPlanLastDay: string,
  // The real Monday date of the PRIOR plan's own week (i.e.
  // previousWeekStart(thisWeek's weekStart)) — resolves the shift regime
  // effective on that prior plan's real last day (see
  // lib/shift-templates.ts). Required so a boundary seed straddling
  // 2026-09-20 (a prior week entirely before it, feeding a new week on or
  // after it) resolves the PRIOR shift under the regime that was actually
  // effective then, never the new week's regime.
  priorWeekStart: string
): PriorDayShiftMap {
  const map: PriorDayShiftMap = new Map();
  const priorPlanLastDate = flightDateFor(priorWeekStart, priorPlanLastDay);
  for (const employee of employees) {
    const entry = priorPlanRosterEntries.find(
      (r) => r.employee_id === employee.id && r.day_of_week === priorPlanLastDay
    );
    if (!entry || entry.status === "off" || !entry.shift_code) {
      map.set(employee.id, null);
      continue;
    }
    map.set(employee.id, getShiftTimesAs(entry.shift_code, priorPlanLastDate));
  }
  return map;
}

/**
 * Fallback boundary context for a plan with no real predecessor to read
 * from yet (the first-ever WeeklyPlan generated for this population, or
 * any week whose immediately preceding week was never generated/persisted).
 * Leaving priorDayShift empty in that case is exactly the "Monday resets
 * with no rest check against the day before it at all" bug this milestone
 * fixes -- a genuine, observed case (see the delivered report): a
 * displayed week's own Sunday->Monday wraparound is real, continuous
 * calendar adjacency even when no separate persisted "week before" plan
 * exists.
 *
 * This uses each employee's own static baseline weekly_shifts entry for
 * daysOrder's LAST day as the stand-in for "what they were most recently
 * doing" -- symmetric with generate-draft-plan.ts's existing
 * nextDayBaselineShift approach at the forward edge, and consistent with
 * the continuous-roster framing: an employee's own baseline pattern is
 * assumed to continue until Stage 6 (or a fixed cycle) actually generates
 * something that overrides it.
 */
export function deriveFallbackBoundaryContext(employees: Employee[], daysOrder: string[], weekStart: string): PriorDayShiftMap {
  const lastDay = daysOrder[daysOrder.length - 1];
  // The stand-in "day before this window" date: this window's own last
  // day, one week earlier — matches this function's own doc comment
  // (an employee's own baseline is assumed to continue from their most
  // recent pattern) and resolves the regime effective on THAT date, not
  // the upcoming window's.
  const standInDate = flightDateFor(shiftWeek(weekStart, -1), lastDay);
  const map: PriorDayShiftMap = new Map();
  for (const employee of employees) {
    map.set(employee.id, effectiveShiftForDay(employee, lastDay, [], standInDate));
  }
  return map;
}
