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

/**
 * SOFT preference check (Part 2 of the product owner's confirmed
 * guidance): a normal flexible employee's `normalWeeklyOffDays` OFF days
 * should normally form ONE CONSECUTIVE block within the displayed window
 * (e.g. Sat/Sun) — but a legal SEPARATED pattern (e.g. Tue + Fri) must
 * remain fully valid, never blocked. This function only ever FLAGS, never
 * fails, that softer case — see lib/planning/validation.ts's
 * `separated_off_days` PlanIssue, wired in as a non-blocking Plan Warning
 * distinct from `consecutive_off_violation` (the unrelated, unchanged,
 * hard max-2-consecutive-OFF ceiling).
 *
 * Deliberately scoped to EXACTLY `normalWeeklyOffDays` OFF days in this
 * window: an employee with a different OFF-day count already has a
 * different, more specific finding elsewhere (an obligation shortfall,
 * an unfilled_duty, or a consecutive_off_violation) — this preference is
 * only meaningful once the normal 5-worked/`normalWeeklyOffDays`-OFF
 * shape itself is already met.
 *
 * Reuses maxConsecutiveOffCyclic (the same wraparound-aware run-length
 * convention as the hard check above) rather than a separate ad-hoc
 * adjacency test: the OFF days are consecutive, in the cyclic sense this
 * whole module already uses, exactly when the longest OFF run equals the
 * total OFF-day count (i.e. every OFF day belongs to the same one run).
 */
export function checkOffDaysSeparated(
  employee: Employee,
  daysOrder: string[],
  normalWeeklyOffDays: number
): SeparatedOffDaysFinding | null {
  const statusByDay = daysOrder.map((day) => {
    const entry = employee.weekly_shifts.find((s) => s.day_of_week === day);
    return { status: (entry?.status ?? "off") as "working" | "off" };
  });
  const offDays = daysOrder.filter((day, i) => statusByDay[i].status === "off");
  if (offDays.length !== normalWeeklyOffDays) return null; // out of scope for this preference — see doc comment above

  const longestRun = maxConsecutiveOffCyclic(statusByDay);
  if (longestRun >= offDays.length) return null; // already one consecutive block — compliant with the preference

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
