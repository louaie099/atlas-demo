import { LaborRuleSource } from "./labor-rules";

/**
 * BREAK POLICY — scheduled span vs. PAID hours (2026-10-20, Labor Rules v2,
 * Phase 2, Option C — confirmed decision, see docs/known-limitations/
 * labor-rules-v2.md). Two genuinely different numbers exist for every
 * shift occurrence from now on:
 *
 *   - SCHEDULED SPAN (lib/planning/paid-hours.ts's scheduledSpanHours) —
 *     raw entrée->sortie elapsed time, exactly what
 *     lib/shift-templates.ts's getShiftDurationHours already computed.
 *     Used for: max continuous shift duration, rest-between-shifts,
 *     fatigue/recovery analysis. NEVER reduced by a break — an unpaid
 *     break does not un-tire anyone, and nothing in lib/fatigue-config.ts
 *     models a recovery effect from a mid-shift break, so none is assumed
 *     here either.
 *   - PAID HOURS (paid-hours.ts's paidHours) — scheduled span minus an
 *     unpaid-break deduction, ONLY when this policy is both enabled and
 *     applicable to that shift's length. Used for: weekly/monthly hour
 *     ceilings/floors only.
 *
 * `enabled: false` (the default, and the only state until RAM Handling
 * confirms a real break policy) makes paid hours exactly equal to
 * scheduled span — a genuine no-op, never a guessed deduction. Every
 * consumer of paid hours must treat a result computed while
 * `source: "unconfirmed_prototype"` as PROVISIONAL and label it as such
 * wherever it is shown or reported — see PaidHoursResult.provisional in
 * paid-hours.ts.
 *
 * Do NOT invent unpaidBreakMinutesPerShift or minimumShiftHoursForBreak
 * speculatively. Both stay null until a real policy is confirmed; setting
 * either without a confirmed number would silently misstate every
 * employee's weekly/monthly hour totals exactly like this codebase's
 * other "don't invent a business rule" fields (workingHoursObligationHours,
 * operationalBufferMinutes).
 */
export interface BreakPolicy {
  enabled: boolean;
  source: LaborRuleSource;
  /** Flat unpaid-break deduction applied once per qualifying shift, in minutes. null = not configured. */
  unpaidBreakMinutesPerShift: number | null;
  /** A shift must be at least this many scheduled-span hours to qualify for the deduction. null = applies to every shift (when enabled). */
  minimumShiftHoursForBreak: number | null;
}

export const DEFAULT_BREAK_POLICY: BreakPolicy = {
  enabled: false,
  source: "unconfirmed_prototype",
  unpaidBreakMinutesPerShift: null,
  minimumShiftHoursForBreak: null,
};
