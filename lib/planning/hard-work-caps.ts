import type { Config } from "../types";
import { resolveDefaultLaborRules } from "../labor-rules";

/**
 * HARD WORK CAPS (2026-09-25, hard-constraints milestone PHASE 1 of 3).
 *
 * ONE remaining hard constraint for every GENERATION-DRIVEN population — the
 * flexible General T1 pool (Stage 6, shift-generation.ts, and its Stage-6.5
 * top-up, roster-generation.ts), Profiling/Mesure and every foreign-company
 * team (specialized-team-generation.ts): never more than
 * `maxConsecutiveWorkDays` (default 5) CONSECUTIVE calendar work days,
 * counted continuously across week boundaries. (A second cap — a
 * single-displayed-week HOURS ceiling — existed here until 2026-09-29; see
 * the removal note below for why it is gone, not merely relabeled.)
 *
 * MECHANISM — exactly the 15h rest rule's: a pure predicate each generation
 * gate evaluates BEFORE scoring, alongside its existing rest-legality filter
 * (Stage 6's legalCodesByEmployee, the top-up's legalCodesAt,
 * selectCompatibleShiftCodes for Profiling/Mesure/foreign). A candidate that
 * would break the cap is simply never scored and never assigned. There is
 * deliberately no post-hoc repair/drop pass here and no second legality
 * mechanism.
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
 * PHASE 2 (2026-09-25) has landed on top of — not instead of — this filter:
 * hard-cap-repair.ts runs a bounded, deterministic cross-employee repair
 * AFTER each population's greedy generation (only when the cap excluded
 * someone). The filter here is unchanged and every repaired week is
 * re-checked against it. (roster-target.ts's per-employee cap-aware roster
 * target, mentioned here through 2026-09-28, was hours-based and is now
 * removed — see below.)
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
 *
 * 2026-09-29 REMOVAL (Planning Rules milestone, follow-up audit): the
 * single-displayed-week HOURS cap (`hardWeeklyHoursCap`, 42h) that used to
 * exist here has been REMOVED, not merely excluded from the new
 * configuration model. Audited and confirmed: it rejected candidate shift
 * codes outright (shift-generation.ts's Stage 6, roster-generation.ts's
 * top-up, foreign-shift-planning.ts's selectCompatibleShiftCodes) AND, more
 * subtly, throttled how many days an employee was even TARGETED to work at
 * all (roster-target.ts's computeCapAwareTargetWorkDays reduced the normal
 * 5-day target below 5 whenever an employee's real shift codes would sum
 * past 42h, and cap-paced-rest.ts's memberCapacityDays capped a team's
 * weekly capacity the same way) — both are the SAME forbidden behavior
 * ("42h treated as a hard Monday-Sunday ceiling") just expressed as a
 * target/capacity throttle instead of a per-candidate rejection, and both
 * are gone now too. The confirmed rule is `maximumAverageWeeklyWorkingHours`
 * (see lib/labor-rules.ts) — an AVERAGE over a still-unconfirmed reference
 * period, `not_evaluable` until that period is configured, and genuinely
 * NOT a per-displayed-week ceiling. A legitimate configured shift
 * combination that sums past 42h inside one displayed week is NOT rejected
 * by anything in this codebase any more — see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md's
 * 2026-09-29 "hard 42h cap removed" addendum for the full audit trail.
 *
 * `maxConsecutiveWorkDays` (5 consecutive calendar days) is UNCHANGED and
 * REMAINS a real hard cap — a genuinely different, non-hours-based concept
 * the correction above does not touch. It is still resolved from
 * lib/labor-rules.ts (see DEFAULT_MAX_CONSECUTIVE_WORK_DAYS below) so there
 * is one canonical number, honestly labeled `unconfirmed_prototype` there
 * (normal flexible ACEs being configured for 5 WORK + 2 OFF does not, by
 * itself, prove a separate confirmed rule that nobody may EVER work more
 * than 5 consecutive calendar days across week boundaries).
 */

/**
 * Default hard cap on consecutive calendar work days. DERIVED from
 * lib/labor-rules.ts's DEFAULT_LABOR_RULES so there is one canonical
 * number — see this module's 2026-09-29 correction note above on why its
 * PROVENANCE there is honestly unconfirmed_prototype, not a confirmed
 * separate labor rule. Kept as its own export here purely as
 * `resolveHardWorkCaps`'s defensive fallback for a pre-migration
 * `config_snapshot` that predates this field.
 */
export const DEFAULT_MAX_CONSECUTIVE_WORK_DAYS = resolveDefaultLaborRules().maxConsecutiveWorkDays;

export interface HardWorkCaps {
  maxConsecutiveWorkDays: number;
}

/**
 * The cap in force for a Config. A config object persisted before this
 * phase (an old plan's config_snapshot) lacks the field — it falls back to
 * the default rather than silently disabling a hard rule.
 */
export function resolveHardWorkCaps(config: Partial<Pick<Config, "max_consecutive_work_days">>): HardWorkCaps {
  return {
    maxConsecutiveWorkDays: typeof config.max_consecutive_work_days === "number" ? config.max_consecutive_work_days : DEFAULT_MAX_CONSECUTIVE_WORK_DAYS,
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

export type HardCapExclusionReason = "consecutive_work_days";

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
