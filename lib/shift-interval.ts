import { nextCalendarDate } from "./flight-date";

/**
 * Shared, canonical overnight-shift semantics (2026-10-06 activation).
 *
 * Root cause this module fixes: every shift-code candidate matcher in the
 * codebase (lib/planning/shift-generation.ts's General T1 pool,
 * lib/foreign-shift-planning.ts's selectCompatibleShiftCodes, used by
 * specialized-team-generation.ts and hard-cap-repair.ts) treated
 * `sortie < entree` as "an invalid/unsupported time range" and silently
 * excluded the code entirely. That is a false assumption: AP03, AP04,
 * NT01 and N8 (see lib/shift-templates.ts) are real, confirmed shift
 * codes whose sortie clock-time is numerically earlier than their entree
 * only because the shift wraps past midnight — the correct reading is
 * `sortie <= entree` => "this shift ends on the FOLLOWING calendar date",
 * never "this shift is unsupported." Excluding them left a real, nightly
 * dead zone (roughly 23:15-03:45 in the current effective regime) with
 * ZERO generatable roster capacity, for any population, regardless of
 * headcount — see the 2026-10-06 audit.
 *
 * This module is the single place that resolves a shift's real date-time
 * interval. Every caller that needs to know whether/how a shift covers a
 * same-day window goes through `reachOfDayMinutes` or `shiftPortionOnDate`
 * below, rather than re-deriving its own overnight rule.
 */

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * True when a shift's sortie clock-time is at or before its entree
 * clock-time — a same-shift wrap past midnight (AP03/AP04/NT01/N8 in the
 * current catalog), never an invalid or zero-duration shift. Equal values
 * are also treated as overnight (a shift can't legitimately have zero
 * duration), consistent with lib/shift-templates.ts's getShiftDurationHours
 * (`minutes <= 0` triggers the same `+24h` wrap).
 */
export function isOvernightShift(entree: string, sortie: string): boolean {
  return timeToMinutes(sortie) <= timeToMinutes(entree);
}

/**
 * The real date-time interval a shift occupies, anchored to the calendar
 * date it STARTS on. For an overnight shift the end genuinely falls on
 * the following calendar date — this never pretends the end stays on
 * `date`, per the explicit correctness requirement.
 */
export interface ShiftInterval {
  startDate: string;
  startMinutes: number; // minute-of-day, [0, 1440)
  endDate: string;
  endMinutes: number; // minute-of-day, [0, 1440)
}

export function resolveShiftInterval(date: string, entree: string, sortie: string): ShiftInterval {
  const startMinutes = timeToMinutes(entree);
  const endMinutes = timeToMinutes(sortie);
  const overnight = endMinutes <= startMinutes;
  return { startDate: date, startMinutes, endDate: overnight ? nextCalendarDate(date) : date, endMinutes };
}

/**
 * The portion of a resolved shift interval that falls within the
 * [00:00, 24:00) span of `onDate` — null if the interval doesn't reach
 * `onDate` at all. Translates a genuine cross-midnight interval back into
 * the plain same-day minute-of-day window the rest of the
 * scoring/eligibility pipeline already works with (TimeWindow,
 * windowsOverlap, isWindowWithinShift, scoreCandidates' shift_start/
 * shift_end) — without making those callers date-aware themselves. Every
 * demand/requirement window this codebase computes is itself confined to
 * one calendar day (demand-aggregation.ts's 48 fixed per-day buckets), so
 * clipping the shift's reach to a single day's [0, 1440) span is always
 * sufficient for matching against one.
 */
export function shiftPortionOnDate(interval: ShiftInterval, onDate: string): { start: number; end: number } | null {
  const touchesStart = interval.startDate === onDate;
  const touchesEnd = interval.endDate === onDate;
  if (touchesStart && touchesEnd) return { start: interval.startMinutes, end: interval.endMinutes }; // ordinary same-day shift
  if (touchesStart) return { start: interval.startMinutes, end: 1440 }; // overnight shift's tail, on the day it STARTS
  if (touchesEnd) return { start: 0, end: interval.endMinutes }; // overnight shift's carryover, on the FOLLOWING day
  return null;
}

/**
 * Minutes-of-day a shift code "reaches" on the calendar day it STARTS —
 * 1440 (end of day) for an overnight code, its real sortie minute
 * otherwise. The single containment/coverage upper bound Stage 6
 * (shift-generation.ts's bucketsCoveredBy) and selectCompatibleShiftCodes
 * both need for same-day matching: a same-day demand window/requirement
 * window never extends past 24:00, so an overnight code that keeps
 * running past midnight always satisfies it, exactly as if its sortie
 * were the end of the day.
 */
export function reachOfDayMinutes(entreeMin: number, sortieMin: number): number {
  return sortieMin <= entreeMin ? 1440 : sortieMin;
}

/**
 * The true, wrap-aware duration of a shift in minutes, from its own
 * entree/sortie minute-of-day values — mirrors
 * lib/shift-templates.ts's getShiftDurationHours (kept as a separate,
 * minutes-based helper here since Stage 6 and selectCompatibleShiftCodes
 * both already carry entreeMin/sortieMin as plain numbers and comparing
 * `sortieMin - entreeMin` directly, unguarded, produces a NEGATIVE number
 * for an overnight code — which previously made every overnight code look
 * like the shortest possible shift in a duration tie-break, rather than a
 * genuine 8-13h shift).
 */
export function shiftDurationMinutes(entreeMin: number, sortieMin: number): number {
  const raw = sortieMin - entreeMin;
  return raw > 0 ? raw : raw + 24 * 60;
}
