import { Employee, WeeklyPlanRosterEntry } from "../types";
import { deriveTransitionContextFromPriorPlan, deriveFallbackContextForDay, previousWeekStart, BoundaryContextProvenance } from "./rotation-context";
import { isGenerationDrivenPopulation } from "./workforce-pools";
import { DEFAULT_FATIGUE_CONFIG, FatigueConfig } from "../fatigue-config";
import {
  FatigueState,
  UnknownFatigueState,
  FatigueProvenance,
  ResolvedSpan,
  accumulateFatigue,
  neutralFatigueState,
  shiftBurdenBreakdownForSpan,
  spanFromResolvedTimes,
  transitionBurdenForSpans,
  unknownFatigueState,
} from "./fatigue-model";

/**
 * FATIGUE CONTINUITY SEED (2026-09-24, fatigue-aware roster planning
 * milestone, part 1 — "Part B"). Derives the FatigueState an employee
 * carries INTO a week from whatever real prior-week context exists — the
 * cross-week continuity counterpart of rotation-context.ts's rest boundary
 * seed, built ON TOP of that module's existing data sources (it calls
 * deriveTransitionContextFromPriorPlan / deriveFallbackContextForDay for
 * each prior-week day rather than re-reading roster rows or baselines on
 * its own).
 *
 * Pure and deterministic. Part 2 (2026-09-24): generateDraftWeeklyPlan
 * accepts these seeds via planningOptions.fatigue.incomingSeeds (an
 * employee with no seed is treated as an explicit unknown). The
 * persistence-layer caller (weekly-plan-service.ts) does not derive or
 * pass them yet — FATIGUE_MODEL_ENABLED is still false.
 *
 * The three honest outcomes, each with a distinct shape:
 *   - { source: "prior_plan", state: FatigueState(provenance "prior_plan") }
 *     — a REAL persisted predecessor plan's roster, day by day.
 *   - { source: "fallback_static_baseline", approximate: true, state:
 *     FatigueState(provenance "fallback_static_baseline") } — no
 *     predecessor plan, but the employee has an authoritative static
 *     baseline (fixed-cycle/static teams), stood in exactly the way
 *     deriveFallbackBoundaryContext already does. A documented
 *     approximation, flagged as such.
 *   - { source: "unknown", state: UnknownFatigueState } — nothing real is
 *     known: no context at all, the employee is absent from the
 *     predecessor plan, or only a static baseline exists for a
 *     DEMAND-DRIVEN employee (flexible ACE, Profiling/Mesure, foreign
 *     company), for whom the baseline is explicitly not authoritative.
 *     NEVER a fabricated plausible previous week.
 *
 * Only ONE week back is ever read — the same "minimum state that must
 * persist between weeks" scope as the rest boundary seed. The seed starts
 * from a neutral zero at the start of that prior week.
 */

export type IncomingFatigueSeed =
  | { source: "prior_plan"; state: FatigueState }
  | { source: "fallback_static_baseline"; approximate: true; state: FatigueState }
  | { source: "unknown"; state: UnknownFatigueState };

export type FatigueSeedInput =
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

/** Maps rotation-context.ts's boundary provenance onto the seed input kind a caller should build (convenience for the next phase's wiring). */
export function fatigueSeedKindFor(provenance: BoundaryContextProvenance): FatigueSeedInput["kind"] {
  return provenance === "prior_plan" ? "prior_plan" : provenance === "fallback_static_baseline" ? "fallback_static_baseline" : "none";
}

function foldDays(provenance: FatigueProvenance, spans: (ResolvedSpan | null)[], config: FatigueConfig): FatigueState {
  let state = neutralFatigueState(provenance);
  let lastWorked: { span: ResolvedSpan; index: number } | null = null;
  spans.forEach((span, index) => {
    if (!span) {
      state = accumulateFatigue(state, 0, true, config.weights.recoveryWeight, config);
      return;
    }
    const breakdown = shiftBurdenBreakdownForSpan(span, config);
    if (config.enabled) {
      breakdown.transitionComponent = transitionBurdenForSpans(lastWorked?.span ?? null, span, lastWorked ? index - lastWorked.index : 0, config);
      breakdown.dayBurden += breakdown.transitionComponent;
    }
    state = accumulateFatigue(state, breakdown.dayBurden, false, config.weights.recoveryWeight, config, breakdown);
    lastWorked = { span, index };
  });
  return state;
}

/**
 * The FatigueState `employee` carries into the week described by `input`.
 * See this module's doc comment for the three outcomes.
 */
export function deriveIncomingFatigueState(
  employee: Employee,
  input: FatigueSeedInput,
  config: FatigueConfig = DEFAULT_FATIGUE_CONFIG
): IncomingFatigueSeed {
  if (input.kind === "none") {
    return { source: "unknown", state: unknownFatigueState("No prior-week context available (first-ever week or no predecessor data).") };
  }

  if (input.kind === "prior_plan") {
    const hasAnyRow = input.priorPlanRosterEntries.some((r) => r.employee_id === employee.id);
    if (!hasAnyRow) {
      // deriveTransitionContextFromPriorPlan maps a missing row to null
      // (OFF) for rest purposes — correct for a rest gate, but for fatigue
      // an employee absent from the whole predecessor plan has NO history,
      // not a week of OFF days.
      return { source: "unknown", state: unknownFatigueState("Employee has no roster rows in the predecessor plan.") };
    }
    const priorWeekStart = previousWeekStart(input.weekStart);
    const spans = input.daysOrder.map((day) => {
      const times = deriveTransitionContextFromPriorPlan([employee], input.priorPlanRosterEntries, day, priorWeekStart).get(employee.id);
      return times ? spanFromResolvedTimes(times.shift_start, times.shift_end) : null;
    });
    return { source: "prior_plan", state: foldDays("prior_plan", spans, config) };
  }

  // Static-baseline fallback — only meaningful where the baseline is
  // authoritative (the same population split generate-draft-plan.ts uses).
  if (isGenerationDrivenPopulation(employee)) {
    return {
      source: "unknown",
      state: unknownFatigueState("Only a static baseline is available, and it is not authoritative for a demand-driven employee."),
    };
  }
  const spans = input.daysOrder.map((day) => {
    const times = deriveFallbackContextForDay([employee], day, input.weekStart).get(employee.id);
    return times ? spanFromResolvedTimes(times.shift_start, times.shift_end) : null;
  });
  return { source: "fallback_static_baseline", approximate: true, state: foldDays("fallback_static_baseline", spans, config) };
}
