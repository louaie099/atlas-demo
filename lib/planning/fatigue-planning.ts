import { getShiftTimesAs } from "../shift-templates";
import { FatigueConfig } from "../fatigue-config";
import {
  FatigueBurdenBreakdown,
  FatigueState,
  FatigueStateOrUnknown,
  ResolvedSpan,
  accumulateFatigue,
  explainFatigueFactors,
  neutralFatigueState,
  shiftBurdenBreakdownForSpan,
  spanFromResolvedTimes,
  transitionBurdenForSpans,
  unknownFatigueState,
} from "./fatigue-model";

/**
 * FATIGUE PLANNER GLUE (2026-09-24, fatigue-aware roster planning
 * milestone, part 2). The thin layer between the pure fatigue model
 * (fatigue-model.ts / fatigue-continuity.ts, part 1) and the planner's
 * real decision points:
 *
 *   - Stage 6 (shift-generation.ts's generateFlexiblePoolShifts) — tier 4
 *     of stage6-score-tiers.ts, via Stage6FatigueContext below;
 *   - the Stage-6.5 top-up (roster-generation.ts's
 *     computeEmployeeDayCountTopUp) — lower-burden legal code first;
 *   - foreign-company roster distribution (specialized-team-generation.ts's
 *     generateForeignCompanyShifts) — lower-burden team member first;
 *   - Stage 9 / Find-Agent ranking (lib/scoring.ts's scoreCandidates) —
 *     the separate `fairness_weights.fatigueWeight` dimension.
 *
 * EVERYTHING HERE IS INERT unless the caller passes a FatigueConfig whose
 * `enabled` is true. FATIGUE_MODEL_ENABLED (lib/fatigue-config.ts) stays
 * false, so no real plan is affected by this phase: tests (and a future
 * phase's explicit opt-in) construct an enabled config themselves.
 *
 * RUNNING STATE — the FatigueLedger. Stage 6 and the foreign-company
 * roster both walk the week day by day, and inside ONE day an employee
 * receives at most one shift, so an employee's fatigue state never changes
 * within a day. The ledger therefore only needs to advance once per day:
 * it is seeded from each employee's incoming (prior-week) state, the
 * caller reads `statesEnteringDay` for today's decision, and after the day
 * is decided the caller folds the day in (worked code -> accumulateFatigue
 * work day with the real date-resolved breakdown incl. the transition
 * from the last worked shift; not worked -> an OFF/recovery day). No wide
 * rewrite of Stage 6's greedy loop is needed.
 *
 * Every shift time is resolved through getShiftTimesAs(code, realDate) —
 * never SHIFT_CODES — so burden tracks the 2026-09-20 regime change per
 * real calendar day, exactly like the rest of the planner.
 */

/** The last WORKED shift before the day being decided, as a resolved span plus the real calendar date it was worked on. */
export interface LastWorkedShift {
  span: ResolvedSpan;
  date: string; // "YYYY-MM-DD"
}

/**
 * Stage 6's fatigue input for ONE day (the tier-4 counterpart of
 * off-window.ts's Stage6OffWindowContext). `statesEnteringDay` is each
 * employee's state BEFORE today's shift — an employee absent from it is
 * treated as an explicit unknown (neutral start, never a fabricated
 * history). `lastWorkedShift` feeds the transition component.
 */
export interface Stage6FatigueContext {
  config: FatigueConfig;
  statesEnteringDay: ReadonlyMap<string, FatigueStateOrUnknown>;
  lastWorkedShift?: ReadonlyMap<string, LastWorkedShift>;
}

/** One (employee, code, date) option projected through the fatigue model — the structured data explanations are built from. */
export interface FatigueCandidateProjection {
  employeeId: string;
  code: string;
  date: string;
  /** The employee's state entering the day (possibly unknown). */
  before: FatigueStateOrUnknown;
  /** Today's burden breakdown for this code on this real date, including the transition from the last worked shift. */
  breakdown: FatigueBurdenBreakdown;
  /** The state after working this code today (compounding applied). `after.accumulatedBurden` is what the planner ranks by. */
  after: FatigueState;
}

function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(5, 7) - 1, +fromDate.slice(8, 10));
  const b = Date.UTC(+toDate.slice(0, 4), +toDate.slice(5, 7) - 1, +toDate.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** The real, date-resolved span of `code` worked on `date`. */
export function shiftSpanOnDate(code: string, date: string): ResolvedSpan {
  const { shift_start, shift_end } = getShiftTimesAs(code, date);
  return spanFromResolvedTimes(shift_start, shift_end);
}

/**
 * Projects working `code` on the real `date` for an employee whose state
 * entering the day is `before` and whose last worked shift was
 * `lastWorked` (null/undefined = none known -> no transition cost).
 * Pure; under a disabled config every burden is 0.
 */
export function projectFatigueForShift(
  employeeId: string,
  before: FatigueStateOrUnknown,
  lastWorked: LastWorkedShift | null | undefined,
  code: string,
  date: string,
  config: FatigueConfig
): FatigueCandidateProjection {
  const span = shiftSpanOnDate(code, date);
  const breakdown = shiftBurdenBreakdownForSpan(span, config);
  if (config.enabled && lastWorked) {
    breakdown.transitionComponent = transitionBurdenForSpans(lastWorked.span, span, daysBetween(lastWorked.date, date), config);
    breakdown.dayBurden += breakdown.transitionComponent;
  }
  const after = accumulateFatigue(before, breakdown.dayBurden, false, config.weights.recoveryWeight, config, breakdown);
  return { employeeId, code, date, before, breakdown, after };
}

/**
 * Human-readable reasons (explainFatigueFactors — never a raw number) for
 * why `winner` was chosen over `runnerUp` — by convention the option the
 * planner WOULD have chosen without the fatigue signal (the one fatigue
 * displaced). Two independent parts, concatenated (deduplicated, at most
 * `maxReasons`, default 3):
 *   - a DIFFERENT employee -> compares the two employees' states ENTERING
 *     the day (recent history), with the winner's shift breakdown as
 *     `candidateShift` (enables "Avoids third consecutive very-early
 *     shift");
 *   - a DIFFERENT code -> compares what each code alone would add, both
 *     folded onto the same neutral base (so a difference is exactly the
 *     codes' own component difference, independent of history).
 * `runnerUp` null (fatigue did not change the choice) -> []. Returns []
 * when the config is disabled.
 */
export function explainFatigueChoice(
  winner: FatigueCandidateProjection,
  runnerUp: FatigueCandidateProjection | null,
  config: FatigueConfig,
  maxReasons = 3
): string[] {
  if (!config.enabled || !runnerUp) return [];
  const reasons: string[] = [];
  if (runnerUp.employeeId !== winner.employeeId) {
    reasons.push(...explainFatigueFactors(winner.before, { comparedWith: runnerUp.before, candidateShift: winner.breakdown, config, maxReasons }));
  }
  if (runnerUp.code !== winner.code) {
    const base = neutralFatigueState("unknown_start");
    const fold = (p: FatigueCandidateProjection) => accumulateFatigue(base, p.breakdown.dayBurden, false, config.weights.recoveryWeight, config, p.breakdown);
    reasons.push(...explainFatigueFactors(fold(winner), { comparedWith: fold(runnerUp), config, maxReasons }));
  }
  return Array.from(new Set(reasons)).slice(0, maxReasons);
}

/**
 * Running per-employee fatigue state across a day-by-day walk (see this
 * module's doc comment). Mutable by design — owned by exactly one walk.
 */
export interface FatigueLedger {
  config: FatigueConfig;
  states: Map<string, FatigueStateOrUnknown>;
  lastWorked: Map<string, LastWorkedShift>;
}

const NO_SEED_REASON = "No incoming fatigue state supplied for this employee (no prior-week history available to the planner).";

/**
 * Seeds a ledger for `employeeIds`. `incomingStates` is each employee's
 * real state entering the window (fatigue-continuity.ts's
 * deriveIncomingFatigueState(...).state); an employee missing from it gets
 * an explicit UnknownFatigueState — never an invented history.
 * `boundaryShifts` (optional) is the planner's existing
 * priorWeekBoundaryContext (real shift times on the day before the
 * window, `boundaryDate`) — used only as the "last worked shift" for the
 * first day's transition component.
 */
export function createFatigueLedger(
  employeeIds: Iterable<string>,
  config: FatigueConfig,
  incomingStates?: ReadonlyMap<string, FatigueStateOrUnknown>,
  boundaryShifts?: ReadonlyMap<string, { shift_start: string; shift_end: string } | null>,
  boundaryDate?: string
): FatigueLedger {
  const ledger: FatigueLedger = { config, states: new Map(), lastWorked: new Map() };
  for (const id of employeeIds) {
    ledger.states.set(id, incomingStates?.get(id) ?? unknownFatigueState(NO_SEED_REASON));
    const boundary = boundaryShifts?.get(id);
    if (boundary && boundaryDate) {
      ledger.lastWorked.set(id, { span: spanFromResolvedTimes(boundary.shift_start, boundary.shift_end), date: boundaryDate });
    }
  }
  return ledger;
}

/** Today's Stage-6 context from a ledger (read-only views of the ledger's current maps). */
export function stage6FatigueContextFromLedger(ledger: FatigueLedger): Stage6FatigueContext {
  return { config: ledger.config, statesEnteringDay: ledger.states, lastWorkedShift: ledger.lastWorked };
}

/**
 * Folds one decided day into the ledger for EVERY tracked employee:
 * a worked code (from `workedCodeByEmployee`) -> a work day with its real
 * date-resolved breakdown; anyone else -> an OFF/recovery day.
 */
export function advanceFatigueLedger(ledger: FatigueLedger, date: string, workedCodeByEmployee: ReadonlyMap<string, string>): void {
  for (const [id, state] of ledger.states) {
    const code = workedCodeByEmployee.get(id);
    if (code) {
      const projection = projectFatigueForShift(id, state, ledger.lastWorked.get(id), code, date, ledger.config);
      ledger.states.set(id, projection.after);
      ledger.lastWorked.set(id, { span: shiftSpanOnDate(code, date), date });
    } else {
      ledger.states.set(id, accumulateFatigue(state, 0, true, ledger.config.weights.recoveryWeight, ledger.config));
    }
  }
}

/**
 * The fatigue input lib/scoring.ts's scoreCandidates consumes for its
 * separate `fairness_weights.fatigueWeight` dimension: each candidate's
 * recent state (typically the state ENTERING the day of the duty) and the
 * config it was computed with (explanations need `enabled`).
 */
export interface CandidateFatigueInput {
  config: FatigueConfig;
  statesByEmployee: ReadonlyMap<string, FatigueStateOrUnknown>;
}

/** The accumulated burden a ranking compares — an unknown state ranks as a neutral 0 (no fabricated history, no penalty). */
export function rankingBurden(state: FatigueStateOrUnknown | undefined): number {
  return state && state.known ? state.accumulatedBurden : 0;
}
