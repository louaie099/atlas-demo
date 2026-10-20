import { flightDateFor } from "../flight-date";
import { FatigueConfig, DEFAULT_FATIGUE_CONFIG } from "../fatigue-config";
import { ShiftOnDate, accumulateFatigueOverDays, neutralFatigueState } from "./fatigue-model";
import {
  HardWorkCaps,
  isNightShift,
  wouldExceedShiftDurationCap,
  nextConsecutiveNightShiftStreak,
  wouldExceedConsecutiveNightShiftCap,
} from "./hard-work-caps";
import { restLegalAt, hardCapBreach, breaksOffDayRules, RepairLegalityContext, WeekPattern, RepairOffDayRules } from "./hard-cap-repair";
import { PriorDayShiftMap } from "./shift-generation";

/**
 * BOUNDED, DETERMINISTIC ROSTER-LEVEL FATIGUE REPAIR (2026-10-20, LABOR
 * RULES v2's final checklist item).
 *
 * STATUS: an OPT-IN utility, never wired into any default generation
 * pipeline (Stage 6, the Stage-6.5 top-up, Profiling/Mesure, foreign
 * company). It is a no-op unless BOTH the caller explicitly invokes it AND
 * the fatigue model passed to it is enabled (`config.enabled` —
 * lib/fatigue-config.ts's FATIGUE_MODEL_ENABLED stays false, so
 * DEFAULT_FATIGUE_CONFIG alone already makes this a no-op). This mirrors
 * the rest of the fatigue subsystem's "inert by default" posture (see
 * tests/fatigue-model.test.ts's importer allowlist) and Moses's explicit
 * "keep fatigue optimization disabled by default" instruction.
 *
 * SCOPE — DELIBERATELY NARROW. One move type only: a SAME-CODE, TWO-
 * EMPLOYEE, TWO-DAY SWAP. Given employee A working code c on day d (OFF on
 * day e) and employee B working the SAME code c on day e (OFF on day d),
 * the move exchanges WHICH DAY each of them works c on:
 *   before: A = [..., c@d, ..., OFF@e, ...],  B = [..., OFF@d, ..., c@e, ...]
 *   after:  A = [..., OFF@d, ..., c@e, ...],  B = [..., c@d, ..., OFF@e, ...]
 *
 * WHY THIS SHAPE. It is the only move in this milestone that is "free" by
 * construction on every axis the hard-cap-repair.ts precedent treats as
 * sacred, without needing any of that module's cross-employee headroom
 * bookkeeping:
 *   - COVERAGE is identical before and after: day d's need for code c is
 *     covered (by B instead of A), day e's need for code c is covered (by A
 *     instead of B). No slot gains or loses a body.
 *   - Each employee's own WEEKLY/MONTHLY PAID HOURS, shift-code multiset and
 *     total work-day COUNT are untouched: each of A and B still works
 *     exactly the same set of codes across the week, just with their one
 *     occurrence of code c relocated between d and e. So this move can
 *     never be the thing that trips `maximumWeeklyPaidHours` /
 *     `minimumWeeklyPaidHours` / `maxConsecutiveWorkDays`'s COUNT — only
 *     POSITION-sensitive legality (rest adjacency, the night-shift streak,
 *     OFF-day consecutiveness) can change, which is exactly what a fatigue
 *     repair is supposed to touch.
 *   - QUALIFICATION is automatically satisfied: both A and B are already
 *     confirmed-eligible for code c elsewhere in their own roster (that is
 *     the move's own precondition), so no separate skill/role check is
 *     needed the way hard-cap-repair.ts's selectCompatibleShiftCodes is for
 *     its hand-off (which can change WHICH code is worked, not just when).
 *
 * This explicitly does NOT attempt hard-cap-repair.ts's general "ejection
 * chain" hand-off (different codes, net headroom change) or any multi-day
 * chain. A broader fatigue-driven reallocation is a larger, separate
 * exercise outside this milestone's scope — see
 * docs/known-limitations/labor-rules-v2.md.
 *
 * LEGALITY. A candidate swap is applied only if ALL of the following hold
 * for BOTH employees' resulting whole-week patterns:
 *   - 15h rest (restLegalAt, reused verbatim from hard-cap-repair.ts) at the
 *     one day each employee newly WORKS (the only day whose rest adjacency
 *     can newly break — the day each newly goes OFF can only loosen rest,
 *     never break it);
 *   - the consecutive-work-day cap (hardCapBreach, reused verbatim);
 *   - the max-continuous-shift-duration cap, re-checked at the swapped
 *     code's new date for each employee (durations are effective-dated, so
 *     the same code can legally fit one date and not another);
 *   - the max-consecutive-night-shift cap, walked across each employee's
 *     whole new pattern (nightCapBreach below — the same shape as
 *     hardCapBreach, classifying "night" via isNightShift, exactly like
 *     Stage 6's own wiring in hard-work-caps.ts);
 *   - the weekly OFF-day hard rules (breaksOffDayRules, reused verbatim) —
 *     moving the single OFF day from e to d (or vice versa) cannot change
 *     the OFF-day COUNT, but can split or close a consecutive OFF block.
 *
 * A move is accepted only when it is fully legal AND strictly reduces the
 * pair's combined fatigue objective (the sum of A's and B's
 * accumulateFatigueOverDays(...).accumulatedBurden over the whole displayed
 * week, by at least FATIGUE_IMPROVEMENT_EPSILON) — never applied merely to
 * "try" it. Ties and non-improving swaps are left alone.
 *
 * DETERMINISM: employees are sorted by id, days are iterated in daysOrder
 * order, and the search always looks for the first improving, legal swap
 * in that fixed order before re-scanning from the top — same input, same
 * output.
 *
 * BOUND: at most FATIGUE_REPAIR_ATTEMPT_BUDGET candidate evaluations total.
 * Every APPLIED move strictly decreases the whole population's combined
 * accumulatedBurden (a non-negative quantity), so the number of applied
 * moves is independently finite regardless of the budget; an exhausted
 * budget simply stops the search in the last fully-legal state (never
 * half-applied), exactly like hard-cap-repair.ts's own HARD_CAP_REPAIR_
 * ATTEMPT_BUDGET precedent.
 *
 * CROSS-WEEK CONTINUITY: incoming work-day/night-shift streaks and the
 * prior week's real boundary shift are accepted as OPTIONAL inputs
 * (defaulting to 0 / none) — a caller that has real cross-week context
 * (the same kind shift-generation.ts/hard-cap-repair.ts thread through
 * incomingStreakByEmployee / priorWeekBoundaryContext) should supply it;
 * without it, this pass's own legality checks (but never the objective
 * function itself) are scoped to the single displayed week, the same
 * documented limitation as the night-shift cap's Stage-6-only wiring. See
 * docs/known-limitations/labor-rules-v2.md.
 */

export const FATIGUE_REPAIR_ATTEMPT_BUDGET = 2000;

/** Minimum combined-burden decrease required to accept a move — avoids applying a move on floating-point noise alone. */
const FATIGUE_IMPROVEMENT_EPSILON = 1e-6;

export interface FatigueRepairEmployeeInput {
  employeeId: string;
  /** One code (or null = OFF) per daysOrder index. Mutated copies are returned in the result; the input array itself is never mutated. */
  pattern: WeekPattern;
  /** Consecutive calendar work days immediately before this window's first day. Default 0 (no cross-week context supplied). */
  incomingWorkDayStreak?: number;
  /** Consecutive calendar NIGHT shifts immediately before this window's first day. Default 0 (no cross-week context supplied). */
  incomingNightShiftStreak?: number;
}

export interface FatigueRepairInput {
  daysOrder: string[];
  weekStart: string;
  minimumRestHours: number;
  caps: HardWorkCaps;
  /** Weekly OFF-day hard rules to preserve (undefined = skip this check, matching hard-cap-repair.ts's own convention). */
  offDayRules?: RepairOffDayRules;
  /** Real previous-week boundary shift per employee, for the rest check on this window's first day. Default: none known for anyone. */
  priorWeekBoundaryContext?: PriorDayShiftMap;
  employees: FatigueRepairEmployeeInput[];
  /** Must be enabled for this pass to do anything. Defaults to the globally disabled config, i.e. a no-op. */
  fatigueConfig?: FatigueConfig;
  attemptBudget?: number;
}

export interface FatigueRepairMove {
  employeeAId: string;
  employeeBId: string;
  /** daysOrder indices of the two days exchanged. */
  dayIndexA: number;
  dayIndexB: number;
  /** The shared shift code that moved from dayIndexA (A's day) to dayIndexB (B's day). */
  code: string;
  combinedBurdenBefore: number;
  combinedBurdenAfter: number;
  explanation: string;
}

export interface FatigueRepairResult {
  /** Final pattern per employee id -- includes every employee from the input, changed or not. */
  patterns: Map<string, WeekPattern>;
  moves: FatigueRepairMove[];
  attemptsUsed: number;
  budgetExhausted: boolean;
}

function noOpResult(input: FatigueRepairInput): FatigueRepairResult {
  return {
    patterns: new Map(input.employees.map((e) => [e.employeeId, [...e.pattern]])),
    moves: [],
    attemptsUsed: 0,
    budgetExhausted: false,
  };
}

/** The night-shift-streak analogue of hard-cap-repair.ts's hardCapBreach: the cap a whole-week pattern breaks (or null), walked from `incomingNightStreak`. */
function nightCapBreach(ctx: RepairLegalityContext, incomingNightStreak: number, pattern: WeekPattern): boolean {
  if (ctx.caps.maxConsecutiveNightShifts === null) return false;
  let streak = incomingNightStreak;
  for (let i = 0; i < pattern.length; i++) {
    const code = pattern[i];
    if (!code) {
      streak = 0;
      continue;
    }
    const date = flightDateFor(ctx.weekStart, ctx.daysOrder[i]);
    const isNight = isNightShift(code, date);
    if (wouldExceedConsecutiveNightShiftCap(streak, isNight, ctx.caps.maxConsecutiveNightShifts)) return true;
    streak = nextConsecutiveNightShiftStreak(streak, isNight);
  }
  return false;
}

function patternToShiftOnDates(daysOrder: string[], weekStart: string, pattern: WeekPattern): (ShiftOnDate | null)[] {
  return pattern.map((code, i) => (code ? { code, date: flightDateFor(weekStart, daysOrder[i]) } : null));
}

function combinedBurden(daysOrder: string[], weekStart: string, config: FatigueConfig, patA: WeekPattern, patB: WeekPattern): number {
  const a = accumulateFatigueOverDays(neutralFatigueState("unknown_start"), patternToShiftOnDates(daysOrder, weekStart, patA), config);
  const b = accumulateFatigueOverDays(neutralFatigueState("unknown_start"), patternToShiftOnDates(daysOrder, weekStart, patB), config);
  return a.accumulatedBurden + b.accumulatedBurden;
}

/**
 * Runs the bounded, deterministic same-code two-employee two-day swap
 * search described above. Pure: never mutates `input.employees[*].pattern`.
 * A no-op (returns the input patterns unchanged, zero moves) whenever
 * `fatigueConfig` is omitted or disabled -- the default.
 */
export function repairRosterFatigue(input: FatigueRepairInput): FatigueRepairResult {
  const config = input.fatigueConfig ?? DEFAULT_FATIGUE_CONFIG;
  if (!config.enabled) return noOpResult(input);

  const budget = input.attemptBudget ?? FATIGUE_REPAIR_ATTEMPT_BUDGET;
  const sortedIds = [...input.employees.map((e) => e.employeeId)].sort((x, y) => x.localeCompare(y));
  const patterns = new Map<string, WeekPattern>(input.employees.map((e) => [e.employeeId, [...e.pattern]]));
  const incomingWorkStreak = new Map<string, number>(input.employees.map((e) => [e.employeeId, e.incomingWorkDayStreak ?? 0]));
  const incomingNightStreak = new Map<string, number>(input.employees.map((e) => [e.employeeId, e.incomingNightShiftStreak ?? 0]));
  const priorWeekBoundaryContext: PriorDayShiftMap = input.priorWeekBoundaryContext ?? new Map();

  const ctx: RepairLegalityContext = {
    daysOrder: input.daysOrder,
    weekStart: input.weekStart,
    minimumRestHours: input.minimumRestHours,
    caps: input.caps,
    incomingStreakByEmployee: incomingWorkStreak,
    priorWeekBoundaryContext,
  };

  const moves: FatigueRepairMove[] = [];
  const n = input.daysOrder.length;
  let attempts = 0;
  let budgetExhausted = false;

  /**
   * One full deterministic scan for the first improving, legal swap.
   * Returns true and mutates `patterns`/`moves` the moment one is found and
   * applied; returns false once the whole (sorted) candidate space has been
   * exhausted with no improving legal move left, or the budget runs out
   * mid-scan (in which case `budgetExhausted` is set).
   */
  function scanOnce(): boolean {
    for (let ai = 0; ai < sortedIds.length; ai++) {
      for (let bi = ai + 1; bi < sortedIds.length; bi++) {
        const aId = sortedIds[ai];
        const bId = sortedIds[bi];
        const patA = patterns.get(aId)!;
        const patB = patterns.get(bId)!;

        for (let d = 0; d < n; d++) {
          const codeAtD = patA[d];
          if (!codeAtD) continue; // need A working on d
          if (patB[d]) continue; // need B OFF on d

          for (let e = 0; e < n; e++) {
            if (e === d) continue;
            const codeAtE = patB[e];
            if (!codeAtE) continue; // need B working on e
            if (codeAtE !== codeAtD) continue; // same code only (see doc comment)
            if (patA[e]) continue; // need A OFF on e

            if (attempts >= budget) {
              budgetExhausted = true;
              return false;
            }
            attempts++;

            const code = codeAtD;
            const nextPatA = [...patA];
            nextPatA[d] = null;
            nextPatA[e] = code;
            const nextPatB = [...patB];
            nextPatB[d] = code;
            nextPatB[e] = null;

            // Rest legality: only the days that newly become WORKED can newly break rest.
            if (!restLegalAt(ctx, aId, nextPatA, e, code)) continue;
            if (!restLegalAt(ctx, bId, nextPatB, d, code)) continue;

            // Consecutive-work-day cap (count is unchanged; position is).
            if (hardCapBreach(ctx, aId, nextPatA)) continue;
            if (hardCapBreach(ctx, bId, nextPatB)) continue;

            // Max continuous shift duration, re-checked at the swapped code's NEW date for each employee.
            const dateE = flightDateFor(input.weekStart, input.daysOrder[e]);
            const dateD = flightDateFor(input.weekStart, input.daysOrder[d]);
            if (wouldExceedShiftDurationCap(code, dateE, input.caps.maxContinuousShiftHours)) continue;
            if (wouldExceedShiftDurationCap(code, dateD, input.caps.maxContinuousShiftHours)) continue;

            // Max consecutive night shifts, walked across each employee's whole new pattern.
            if (nightCapBreach(ctx, incomingNightStreak.get(aId) ?? 0, nextPatA)) continue;
            if (nightCapBreach(ctx, incomingNightStreak.get(bId) ?? 0, nextPatB)) continue;

            // Weekly OFF-day hard rules: the OFF-day count cannot change, but consecutiveness can.
            if (breaksOffDayRules(patA, nextPatA, input.offDayRules)) continue;
            if (breaksOffDayRules(patB, nextPatB, input.offDayRules)) continue;

            const before = combinedBurden(input.daysOrder, input.weekStart, config, patA, patB);
            const after = combinedBurden(input.daysOrder, input.weekStart, config, nextPatA, nextPatB);
            if (before - after <= FATIGUE_IMPROVEMENT_EPSILON) continue;

            patterns.set(aId, nextPatA);
            patterns.set(bId, nextPatB);
            moves.push({
              employeeAId: aId,
              employeeBId: bId,
              dayIndexA: d,
              dayIndexB: e,
              code,
              combinedBurdenBefore: before,
              combinedBurdenAfter: after,
              explanation: `${aId} and ${bId} swapped which day covers ${code} (${input.daysOrder[d]} <-> ${input.daysOrder[e]}) -- same coverage and hours, lower combined fatigue burden (${before.toFixed(3)} -> ${after.toFixed(3)}).`,
            });
            return true;
          }
        }
      }
    }
    return false;
  }

  // eslint-disable-next-line no-empty
  while (scanOnce()) {}

  return { patterns, moves, attemptsUsed: attempts, budgetExhausted };
}
