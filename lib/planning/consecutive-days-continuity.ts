import { Employee, WeeklyPlanRosterEntry } from "../types";
import { deriveTransitionContextFromPriorPlan, deriveFallbackContextForDay, previousWeekStart } from "./rotation-context";
import { isGenerationDrivenPopulation } from "./workforce-pools";

/**
 * CONSECUTIVE-WORK-DAY CONTINUITY SEED (2026-09-25, hard-constraints
 * milestone phase 1). The streak of consecutive calendar work days an
 * employee carries INTO a week, so the hard max-consecutive-work-days cap
 * (hard-work-caps.ts) is counted continuously across the Sunday→Monday
 * boundary instead of silently resetting every Monday.
 *
 * Mirrors fatigue-continuity.ts's deriveIncomingFatigueState three-way
 * distinction exactly (and reads the SAME rotation-context.ts primitives —
 * deriveTransitionContextFromPriorPlan / deriveFallbackContextForDay — for
 * each prior-week day rather than re-reading roster rows or baselines), but
 * is always on: it never depends on the fatigue model being enabled.
 *
 *   - { source: "prior_plan", streak, lowerBound } — counted backwards from
 *     a REAL persisted predecessor plan's last day. `lowerBound` is true when
 *     every day of that one week read was worked (the true streak may be
 *     longer; only one week back is ever read — the same scope as the rest
 *     boundary seed). With any cap ≤ 7 a lower bound of 7 already forbids
 *     the new week's first day, so this never under-enforces in practice.
 *   - { source: "fallback_static_baseline", approximate: true, streak,
 *     lowerBound } — no predecessor plan, but the employee has an
 *     authoritative static baseline (static/fixed teams), stood in exactly
 *     as deriveFallbackBoundaryContext does. A documented approximation.
 *   - { source: "unknown", streak: null } — nothing real is known: no
 *     context, the employee is absent from the predecessor plan, or only a
 *     static baseline exists for a DEMAND-DRIVEN employee (for whom it is
 *     explicitly not authoritative). NEVER a fabricated 0.
 */
export type IncomingConsecutiveWorkDaysSeed =
  | { source: "prior_plan"; streak: number; lowerBound: boolean }
  | { source: "fallback_static_baseline"; approximate: true; streak: number; lowerBound: boolean }
  | { source: "unknown"; streak: null; reason: string };

/** Same shape as fatigue-continuity.ts's FatigueSeedInput, declared here so this always-on module never imports the fatigue subsystem. */
export type ConsecutiveDaysSeedInput =
  | {
      kind: "prior_plan";
      /** The immediately preceding persisted plan's roster rows (any employees). */
      priorPlanRosterEntries: WeeklyPlanRosterEntry[];
      /** The Monday of the week being SEEDED (the upcoming week) — the prior plan's week is previousWeekStart(this). */
      weekStart: string;
      daysOrder: string[];
    }
  | { kind: "fallback_static_baseline"; weekStart: string; daysOrder: string[] }
  | { kind: "none" };

/** Trailing worked-day count of a week, walking backwards from its last day. */
function trailingStreak(worked: boolean[]): { streak: number; lowerBound: boolean } {
  let streak = 0;
  for (let i = worked.length - 1; i >= 0 && worked[i]; i--) streak++;
  return { streak, lowerBound: worked.length > 0 && streak === worked.length };
}

export function deriveIncomingConsecutiveWorkDays(employee: Employee, input: ConsecutiveDaysSeedInput): IncomingConsecutiveWorkDaysSeed {
  if (input.kind === "none") {
    return { source: "unknown", streak: null, reason: "No prior-week context available (first-ever week or no predecessor data)." };
  }

  if (input.kind === "prior_plan") {
    if (!input.priorPlanRosterEntries.some((r) => r.employee_id === employee.id)) {
      // deriveTransitionContextFromPriorPlan maps a missing row to null (OFF)
      // — right for a rest gate, wrong here: an employee absent from the
      // whole predecessor plan has NO history, not a week of OFF days.
      return { source: "unknown", streak: null, reason: "Employee has no roster rows in the predecessor plan." };
    }
    const priorWeekStart = previousWeekStart(input.weekStart);
    const worked = input.daysOrder.map(
      (day) => deriveTransitionContextFromPriorPlan([employee], input.priorPlanRosterEntries, day, priorWeekStart).get(employee.id) != null
    );
    return { source: "prior_plan", ...trailingStreak(worked) };
  }

  if (isGenerationDrivenPopulation(employee)) {
    return {
      source: "unknown",
      streak: null,
      reason: "Only a static baseline is available, and it is not authoritative for a demand-driven employee.",
    };
  }
  const worked = input.daysOrder.map((day) => deriveFallbackContextForDay([employee], day, input.weekStart).get(employee.id) != null);
  return { source: "fallback_static_baseline", approximate: true, ...trailingStreak(worked) };
}

/**
 * THE POLICY for how the hard consecutive-day filter reads an incoming seed.
 *
 *  - prior_plan / fallback_static_baseline: the seed's own streak (a lower
 *    bound when flagged — see the seed type).
 *  - unknown (or no seed supplied at all): the count STARTS FRESH AT 0 at
 *    generation time, and `known: false` is returned so the caller MUST
 *    surface a visible, non-blocking `consecutive_work_history_unknown` plan
 *    note for the week (generate-draft-plan.ts does).
 *
 * TRADEOFF, stated plainly: 0 is not a claim that the employee was rested —
 * it is "no work that ATLAS knows of". The alternative conservative
 * readings are worse: assuming the cap is already reached would forbid
 * every unknown employee's Monday (a fabricated gap for the whole
 * workforce on a first-ever week), and assuming "this week wraps onto
 * itself" is a hypothesis this codebase already refuses to enforce as a
 * hard rule for demand-driven populations (see validation.ts's
 * cross_week_continuity_uncertain). So the uncertainty is confined to the
 * week's first days, disclosed on the plan, and disappears as soon as a
 * real predecessor plan exists (the production service always seeds from
 * one when it can — weekly-plan-service.ts). Within the displayed week the
 * count is always exact.
 */
export function incomingStreakForHardCap(seed: IncomingConsecutiveWorkDaysSeed | undefined): { streak: number; known: boolean } {
  if (!seed || seed.source === "unknown") return { streak: 0, known: false };
  return { streak: seed.streak, known: true };
}
