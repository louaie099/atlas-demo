import { Employee } from "../types";

/**
 * Confirmed global rest constraint: an agent must never have more than 2
 * CONSECUTIVE OFF days. This must be evaluated ACROSS week boundaries,
 * never by looking at a single Monday–Sunday window in isolation — e.g.
 * Saturday OFF + Sunday OFF + Monday OFF is 3 consecutive OFF days even
 * though the UI splits Saturday/Sunday and Monday across two displayed
 * weeks.
 *
 * For a UNIFORM weekly schedule (everyone except the fixed-cycle teams —
 * see lib/fixed-cycle-rotation.ts) the exact same weekly_shifts pattern
 * repeats identically every week by construction (buildUniformWeeklySchedule
 * / the Rotation Feasibility Engine's output), so "the following week's
 * Monday" is genuinely identical to "this week's Monday" — checking
 * consecutive OFF days by wrapping the displayed week onto ITSELF
 * (Sunday's neighbor is Monday of the SAME array) correctly represents
 * the real continuous schedule. This is NOT valid for a fixed-cycle
 * employee (period 4, not period 7) — those are validated directly
 * against their continuous cycle instead (see
 * lib/fixed-cycle-rotation.ts's maxConsecutiveOffInCycle and this
 * module's tests), never by wrapping a single 7-day snapshot.
 */
export function maxConsecutiveOffCyclic(statusByDay: { status: "working" | "off" }[]): number {
  const n = statusByDay.length;
  if (n === 0) return 0;
  if (statusByDay.every((d) => d.status === "off")) return n; // fully off — no working day to anchor a boundary on

  let maxRun = 0;
  let run = 0;
  // Two passes around the array so a run spanning the Sunday→Monday
  // wraparound is measured as one continuous run, not two fragments.
  for (let i = 0; i < n * 2; i++) {
    if (statusByDay[i % n].status === "off") {
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }
  return Math.min(maxRun, n);
}

export interface ConsecutiveOffViolation {
  employeeId: string;
  employeeName: string;
  maxConsecutiveOffDays: number;
}

export interface SeparatedOffDaysFinding {
  employeeId: string;
  employeeName: string;
  offDays: string[];
}

/** One employee's per-day working/off status over `daysOrder` (a missing entry counts as OFF, the long-standing convention here), plus the OFF days themselves. */
function offDayStatus(employee: Employee, daysOrder: string[]): { statusByDay: { status: "working" | "off" }[]; offDays: string[] } {
  const statusByDay = daysOrder.map((day) => {
    const entry = employee.weekly_shifts.find((s) => s.day_of_week === day);
    return { status: (entry?.status ?? "off") as "working" | "off" };
  });
  const offDays = daysOrder.filter((_day, i) => statusByDay[i].status === "off");
  return { statusByDay, offDays };
}

export interface InsufficientOffDaysFinding {
  employeeId: string;
  employeeName: string;
  offDays: string[];
  minimumOffDays: number;
}

/**
 * HARD FLOOR check (2026-09-29, OFF/OFF phase 1): does this employee have
 * FEWER than `minimumOffDays` (Config.minimum_off_days_per_planning_week —
 * see lib/labor-rules.ts's minimumOffDaysPerPlanningWeek) OFF days in
 * `daysOrder`? Population scoping (generation-driven only, fixed-cycle
 * exempt) and the full-week requirement live in lib/planning/validation.ts's
 * checkMinimumOffDays, not here — this is the pure counting half.
 */
export function checkOffDaysBelowMinimum(employee: Employee, daysOrder: string[], minimumOffDays: number): InsufficientOffDaysFinding | null {
  const { offDays } = offDayStatus(employee, daysOrder);
  if (offDays.length >= minimumOffDays) return null;
  return { employeeId: employee.id, employeeName: employee.name, offDays, minimumOffDays };
}

/**
 * ONE-CONSECUTIVE-BLOCK check: do this employee's OFF days in `daysOrder`
 * form a single consecutive block (cyclic — Sun+Mon is one block)?
 *
 * 2026-09-29 (OFF/OFF phase 1) REDESIGN: this used to bail out unless the
 * OFF-day count was EXACTLY the normal target (`offDays.length !==
 * normalWeeklyOffDays`), so an employee with 3+ OFF days — or, combined
 * with nothing else checking the floor, 0 or 1 — was never checked at all.
 * Now it checks EVERY employee whose count meets the floor
 * (`offDays.length >= minimumOffDays`, Config.minimum_off_days_per_planning_week).
 *
 * Deliberately NOT checked below the floor — that is not a gap: a count
 * below the floor is reported by checkOffDaysBelowMinimum (validation.ts's
 * `insufficient_off_days`) instead, and the two are split so ONE root
 * cause is never double-flagged two different ways. Below the floor the
 * root cause is "an OFF day is missing"; once it is restored, the block's
 * shape is re-evaluated here on the corrected week. (With a floor of 2,
 * 0 or 1 OFF day can't be "split" in any case.)
 *
 * Whether a finding is HARD (`off_days_not_consecutive`) or a SOFT
 * recommendation (`separated_off_days`) is decided by validation.ts's
 * checkSeparatedOffDays (population + Config.normal_off_days_consecutive),
 * not here.
 *
 * Reuses maxConsecutiveOffCyclic (the same wraparound-aware run-length
 * convention as the ceiling check below) rather than a separate ad-hoc
 * adjacency test: the OFF days are consecutive, in the cyclic sense this
 * whole module already uses, exactly when the longest OFF run equals the
 * total OFF-day count (i.e. every OFF day belongs to the same one run).
 */
export function checkOffDaysSeparated(
  employee: Employee,
  daysOrder: string[],
  minimumOffDays: number
): SeparatedOffDaysFinding | null {
  const { statusByDay, offDays } = offDayStatus(employee, daysOrder);
  if (offDays.length === 0 || offDays.length < minimumOffDays) return null; // below the floor: checkOffDaysBelowMinimum's finding, never double-flagged — see doc comment above

  const longestRun = maxConsecutiveOffCyclic(statusByDay);
  if (longestRun >= offDays.length) return null; // already one consecutive block

  return { employeeId: employee.id, employeeName: employee.name, offDays };
}

/**
 * Checks one employee's weekly_shifts (already in day order) for a
 * consecutive-OFF violation against the RESOLVED labor-rule threshold
 * (see lib/labor-rules.ts's maxConsecutiveOffDays, threaded in via
 * Config.max_consecutive_off_days) — never a value hardcoded here.
 * Returns null when compliant (run <= maxAllowed).
 */
export function checkConsecutiveOffCyclic(employee: Employee, maxAllowed: number): ConsecutiveOffViolation | null {
  const run = maxConsecutiveOffCyclic(employee.weekly_shifts.map((s) => ({ status: s.status })));
  if (run > maxAllowed) {
    return { employeeId: employee.id, employeeName: employee.name, maxConsecutiveOffDays: run };
  }
  return null;
}
