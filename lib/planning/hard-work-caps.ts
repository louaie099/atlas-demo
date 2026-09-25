import type { Config } from "../types";

/**
 * HARD WORK CAPS (2026-09-25, hard-constraints milestone PHASE 1 of 3).
 *
 * Two new hard constraints for every GENERATION-DRIVEN population — the
 * flexible General T1 pool (Stage 6, shift-generation.ts, and its Stage-6.5
 * top-up, roster-generation.ts), Profiling/Mesure and every foreign-company
 * team (specialized-team-generation.ts):
 *
 *   1. never more than `maxConsecutiveWorkDays` (default 5) CONSECUTIVE
 *      calendar work days, counted continuously across week boundaries;
 *   2. never more than `hardWeeklyHoursCap` (default 42) scheduled hours in
 *      a single displayed Monday-Sunday window.
 *
 * MECHANISM — exactly the 15h rest rule's: these are pure predicates that
 * each generation gate evaluates BEFORE scoring, alongside its existing
 * rest-legality filter (Stage 6's legalCodesByEmployee, the top-up's
 * legalCodesAt, selectCompatibleShiftCodes for Profiling/Mesure/foreign). A
 * candidate that would break either cap is simply never scored and never
 * assigned. There is deliberately no post-hoc repair/drop pass here and no
 * second legality mechanism.
 *
 * EXEMPT: the fixed JR→NT→OFF→OFF rotation (Transit/Leaders/Duty Officers,
 * lib/fixed-cycle-rotation.ts — audited to never exceed 2 consecutive work
 * days) and every other static team (Caisse/BCB, ...). They never pass
 * through a generation gate, so nothing here can touch them.
 *
 * PHASE-1 LIMITATION (by design): the filter is naive/greedy — it can create
 * a real coverage gap that a cross-employee reallocation could have avoided
 * (e.g. Stage 6 spends an employee's 5 days early in the week, so they are
 * unavailable on day 6 even though another employee could have taken one
 * of their earlier days). Such gaps are reported honestly; the
 * cross-employee repair pass is PHASE 2. See
 * docs/known-limitations/roster-planning-vs-duty-allocation.md.
 *
 * RUNNING STATE is always-on and independent of the (disabled-by-default)
 * fatigue subsystem: callers keep their own per-employee consecutive-work-
 * day streak (nextConsecutiveWorkDayStreak — same increment/reset semantics
 * as fatigue-model.ts's FatigueState.consecutiveWorkDays, but never routed
 * through FATIGUE_MODEL_ENABLED) and REUSE their existing weekly hours
 * running totals (Stage 6's hoursSoFarThisWeek, Profiling/Mesure/foreign's
 * usageHours, the top-up's scheduled hours) — the hard comparison is simply
 * added at the filter stage; those totals' soft tie-break roles are
 * untouched.
 */

/** Default hard cap on consecutive calendar work days (management rule, 2026-09-25). */
export const DEFAULT_MAX_CONSECUTIVE_WORK_DAYS = 5;

/**
 * Default hard single-displayed-week hours cap. The SAME NUMBER as
 * Config.maximum_average_weekly_working_hours (42) on purpose, but a
 * separate constant: it is a different concept (hard, one displayed week)
 * from that confirmed AVERAGE, and must never be derived from it — see
 * lib/types.ts's Config.hard_weekly_hours_cap doc comment.
 */
export const DEFAULT_HARD_WEEKLY_HOURS_CAP = 42;

/** Tolerance for floating-point hour sums (quarter-hour shift durations). */
const HOURS_EPSILON = 1e-9;

export interface HardWorkCaps {
  maxConsecutiveWorkDays: number;
  hardWeeklyHoursCap: number;
}

/**
 * The caps in force for a Config. A config object persisted before this
 * phase (an old plan's config_snapshot) lacks both fields — it falls back to
 * the defaults rather than silently disabling a hard rule.
 */
export function resolveHardWorkCaps(config: Partial<Pick<Config, "max_consecutive_work_days" | "hard_weekly_hours_cap">>): HardWorkCaps {
  return {
    maxConsecutiveWorkDays: typeof config.max_consecutive_work_days === "number" ? config.max_consecutive_work_days : DEFAULT_MAX_CONSECUTIVE_WORK_DAYS,
    hardWeeklyHoursCap: typeof config.hard_weekly_hours_cap === "number" ? config.hard_weekly_hours_cap : DEFAULT_HARD_WEEKLY_HOURS_CAP,
  };
}

/**
 * The streak entering the NEXT calendar day: +1 after a work day, reset to
 * 0 after an OFF day (identical semantics to fatigue-model.ts's
 * FatigueState.consecutiveWorkDays, kept here so the hard cap never depends
 * on the fatigue model being enabled).
 */
export function nextConsecutiveWorkDayStreak(streakEnteringDay: number, workedToday: boolean): number {
  return workedToday ? streakEnteringDay + 1 : 0;
}

/**
 * Hard eligibility: would working today (isWorkDay) make this the
 * (cap + 1)th consecutive calendar work day? An OFF day never exceeds.
 */
export function wouldExceedConsecutiveDayCap(streakEnteringToday: number, isWorkDay: boolean, cap: number): boolean {
  return isWorkDay && streakEnteringToday + 1 > cap;
}

/**
 * Hard eligibility: would a shift of `candidateShiftHours` push this
 * displayed week's scheduled total past the cap?
 */
export function wouldExceedHardWeeklyHoursCap(hoursSoFarThisWeek: number, candidateShiftHours: number, cap: number): boolean {
  return hoursSoFarThisWeek + candidateShiftHours > cap + HOURS_EPSILON;
}

/**
 * Length of the consecutive work-day run that day `index` would sit in IF it
 * were worked — for passes that fill days out of calendar order (the
 * Stage-6.5 top-up, the foreign-company top-up), where both an earlier and a
 * later run can be joined by the new day. `isWorked(k)` reports whether day
 * k of the window is already worked. A run that reaches the window's first
 * day continues into the prior week's real `incomingStreak`. The window's
 * last day never wraps to its own first day: the next week is not planned
 * yet and will count this week's real trailing streak as ITS incoming one.
 */
export function consecutiveRunLengthIfWorked(isWorked: (k: number) => boolean, index: number, windowLength: number, incomingStreak: number): number {
  let back = 0;
  let k = index - 1;
  while (k >= 0 && isWorked(k)) {
    back++;
    k--;
  }
  if (k < 0) back += incomingStreak;
  let forward = 0;
  k = index + 1;
  while (k < windowLength && isWorked(k)) {
    forward++;
    k++;
  }
  return back + 1 + forward;
}

export type HardCapExclusionReason = "consecutive_work_days" | "hard_weekly_hours";

/**
 * Transparency record: an employee who had at least one REST-LEGAL
 * candidate for a day but was removed from that day's candidate set
 * entirely by a hard cap. An exclusion is NOT necessarily a coverage gap
 * (someone else may have covered the need) — gaps are reported through the
 * existing mechanisms (unfilled_duty, BLOCKING DemandConflict). Kept so
 * phase 2's repair pass has concrete data to start from.
 */
export interface HardCapExclusion {
  employeeId: string;
  dayOfWeek: string;
  population: "flexible_pool" | "flexible_pool_top_up" | "profiling_mesure" | "foreign_company" | "foreign_company_top_up";
  reason: HardCapExclusionReason;
}
