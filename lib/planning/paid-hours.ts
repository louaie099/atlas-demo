import { getShiftDurationHours } from "../shift-templates";
import { BreakPolicy, DEFAULT_BREAK_POLICY } from "../break-policy";

/**
 * SCHEDULED SPAN vs. PAID HOURS — the single place both are derived from a
 * shift occurrence, so no caller re-implements the split (see
 * lib/break-policy.ts's doc comment for the full rationale). Both are
 * ALWAYS computed from the shift catalog (lib/shift-templates.ts) — never
 * persisted per roster entry — so there is exactly one source of truth for
 * a shift's duration and it can never drift from the catalog.
 */

/** Raw entrée->sortie elapsed hours for one shift occurrence, overnight-safe. Never reduced by a break. Use for: max continuous shift duration, rest-between-shifts, fatigue/recovery. */
export function scheduledSpanHours(code: string, date: string): number {
  return getShiftDurationHours(code, date);
}

export interface PaidHoursResult {
  /** The raw scheduled span — identical to scheduledSpanHours(code, date), carried alongside for convenience so a caller never needs both calls. */
  scheduledSpanHours: number;
  /** Scheduled span minus the configured unpaid-break deduction, when applicable. Equals scheduledSpanHours whenever the policy is disabled or doesn't apply to this shift's length. */
  paidHours: number;
  /** true whenever breakPolicy.source is "unconfirmed_prototype" — every caller that surfaces paidHours (UI, validation descriptions) must label it accordingly rather than presenting it as verified contractual hours. */
  provisional: boolean;
  /** true when an unpaid-break deduction was actually applied to this occurrence. */
  breakApplied: boolean;
}

/**
 * Computes both numbers for one shift occurrence under a given break
 * policy. `breakPolicy` defaults to DEFAULT_BREAK_POLICY (disabled) — the
 * honest default until a real policy is confirmed, matching every other
 * "don't guess a business rule" field in this codebase.
 */
export function computePaidHours(code: string, date: string, breakPolicy: BreakPolicy = DEFAULT_BREAK_POLICY): PaidHoursResult {
  const span = scheduledSpanHours(code, date);
  const provisional = breakPolicy.source === "unconfirmed_prototype";

  if (!breakPolicy.enabled || breakPolicy.unpaidBreakMinutesPerShift === null) {
    return { scheduledSpanHours: span, paidHours: span, provisional, breakApplied: false };
  }
  if (breakPolicy.minimumShiftHoursForBreak !== null && span < breakPolicy.minimumShiftHoursForBreak) {
    return { scheduledSpanHours: span, paidHours: span, provisional, breakApplied: false };
  }

  const paid = Math.max(0, span - breakPolicy.unpaidBreakMinutesPerShift / 60);
  return { scheduledSpanHours: span, paidHours: Math.round(paid * 100) / 100, provisional, breakApplied: true };
}
