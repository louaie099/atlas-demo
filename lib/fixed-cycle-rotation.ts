import { WeeklyShiftEntry } from "./types";

/**
 * Fixed Cyclic Rotation — the OTHER legitimate rotation mode, alongside
 * the demand-derived Rotation Feasibility Engine (lib/rotation-
 * feasibility.ts). For a team with a REAL, CONFIRMED repeating pattern
 * (Transit, Leaders — both confirmed as JR → NT → OFF → OFF), the
 * rotation isn't derived from flight demand at all: it's a continuous
 * cycle that repeats every `steps.length` days, independent of Monday–
 * Sunday week boundaries.
 *
 * Generic by construction: nothing in this file branches on a team or
 * company name. A team's PLANNING CONFIGURATION (lib/employee-
 * generator.ts's FIXED_CYCLE_GROUPS) selects which FixedCycleDefinition
 * applies — the engine itself only ever sees the cycle's steps and an
 * employee's position in it. A future team with a real, different
 * confirmed cycle plugs in as a new FixedCycleDefinition, never a new
 * conditional here.
 */

export type CycleStep = { code: string } | { off: true };

export interface FixedCycleDefinition {
  id: string;
  steps: CycleStep[];
}

/**
 * The one currently confirmed fixed cycle, shared by Transit and Leaders:
 * 1 JR day, 1 NT day, 2 OFF days, repeating indefinitely.
 *
 * JR/NT CODE AMBIGUITY (reported, not guessed away): the shift catalog
 * (lib/shift-templates.ts) has exactly one NT code (NT01) — unambiguous —
 * but TWO JR codes (JR01: 05:45–18:15, JR02: 04:30–16:45). Neither
 * Transit nor Leaders had a previously confirmed JR/NT convention before
 * this cycle existed for Transit; Leaders' PRE-EXISTING (pre-cycle)
 * static baseline in this codebase used JR02, so JR02 is reused here for
 * continuity across both teams — but this is a carried-over convention,
 * NOT a confirmed decision, and should be verified against the real
 * confirmed rule before being treated as fact. See the milestone report.
 */
export const JR_NT_OFF_OFF_CYCLE: FixedCycleDefinition = {
  id: "jr_nt_off_off",
  steps: [{ code: "JR02" }, { code: "NT01" }, { off: true }, { off: true }],
};

/**
 * The step at a given ABSOLUTE day index (0 = the reference week's
 * Monday, 1 = Tuesday, ... 7 = the FOLLOWING week's Monday, 8 = its
 * Tuesday, and so on — never resetting to 0 at a week boundary).
 *
 * `cycleOffset` is the STABLE ANCHOR: it's this employee's cycle-step
 * index AT absolute day 0 (the reference week's Monday). Two employees
 * with different offsets are simply at different phases of the exact
 * same continuous cycle — staggering offsets across a team's members is
 * what gives day-to-day coverage variety (not everyone JR/NT/OFF/OFF on
 * the identical calendar days), exactly like buildStaggeredOffDays did
 * for flat-rule teams, but for a cycle instead of a day-set.
 *
 * Because this function takes the RAW absolute day index rather than a
 * day-of-week label, extending it past day 6 (past the displayed week)
 * automatically continues the SAME cycle with no reset — this is the
 * entire mechanism for cross-week continuity. A caller that wants "the
 * following week's Monday" just evaluates absoluteDayIndex = 7; nothing
 * about that call needs to know it's a new calendar week.
 */
export function cycleStepAt(cycle: FixedCycleDefinition, absoluteDayIndex: number, cycleOffset: number): CycleStep {
  const n = cycle.steps.length;
  const position = (((absoluteDayIndex + cycleOffset) % n) + n) % n;
  return cycle.steps[position];
}

/**
 * Builds the displayed week's weekly_shifts from a continuous cycle —
 * `days` is assumed to be Monday-first (absolute day index 0..days.length-1
 * maps directly onto it), matching DAYS_WITH_DATA. The resulting week is
 * only a WINDOW into the continuous rotation: the number of OFF cells
 * visible here can legitimately be 1, 2, or 3 depending on where the
 * 4-day cycle happens to fall against this particular 7-day window — that
 * is expected and correct, not a bug (see the module comment and the
 * milestone report).
 */
export function buildFixedCycleWeeklySchedule(cycle: FixedCycleDefinition, cycleOffset: number, days: string[]): WeeklyShiftEntry[] {
  return days.map((day, absoluteDayIndex) => {
    const step = cycleStepAt(cycle, absoluteDayIndex, cycleOffset);
    if ("off" in step) return { day_of_week: day, shift_code: null, status: "off" as const };
    return { day_of_week: day, shift_code: step.code, status: "working" as const };
  });
}

/** Convenience: which of `days` (Monday-first) are OFF in the displayed window — an informational snapshot, not the full continuous truth (see module comment). */
export function offDaysForDisplayedWeek(cycle: FixedCycleDefinition, cycleOffset: number, days: string[]): string[] {
  return days.filter((day, absoluteDayIndex) => "off" in cycleStepAt(cycle, absoluteDayIndex, cycleOffset));
}

/**
 * The maximum run of consecutive OFF steps the cycle ever produces,
 * evaluated over enough repetitions to make wraparound within the cycle
 * itself irrelevant (a cycle's OFF run can never exceed its own length,
 * and checking 3 full repetitions is more than sufficient for any
 * realistic cycle length). Used both by generation-time validation and by
 * tests — see lib/planning/consecutive-off.ts for the equivalent check
 * against a real generated schedule.
 */
export function maxConsecutiveOffInCycle(cycle: FixedCycleDefinition): number {
  const n = cycle.steps.length;
  let maxRun = 0;
  let run = 0;
  for (let i = 0; i < n * 3; i++) {
    if ("off" in cycle.steps[i % n]) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 0;
    }
  }
  return maxRun;
}
