import { Employee } from "../types";
import { DailyDemand, demandClustersForRole } from "./demand-aggregation";
import { selectCompatibleShiftCodes } from "../foreign-shift-planning";
import { isFlexibleGeneralPool } from "./workforce-pools";
import { restHoursBetween } from "../roster-generation";
import { getShiftTimesAs } from "../shift-templates";

/** An employee's effective shift on the immediately preceding day, or null if they were OFF/unrostered — undefined (not in the map) means "no prior-day data available" (e.g. the first day of the week), which is never treated as a rest violation. */
export type PriorDayShiftMap = Map<string, { shift_start: string; shift_end: string } | null>;

export interface GeneratedShiftAssignment {
  employeeId: string;
  dayOfWeek: string;
  shiftCode: string;
  coversRoles: string[]; // which roles this employee's shift was assigned to help cover
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Circular (clock-of-day) distance between two "HH:mm" start times, in
 * minutes — used only as a CONTINUITY preference (see fairnessKey below),
 * never a hard constraint. A candidate with no known prior start time gets
 * a fixed neutral distance rather than an extreme best/worst score, so
 * "no continuity data" never out-ranks or under-ranks "genuinely close
 * continuity" / "genuinely disruptive change."
 */
function windowsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return timeToMinutes(aStart) < timeToMinutes(bEnd) && timeToMinutes(bStart) < timeToMinutes(aEnd);
}

function circularStartDistanceMinutes(aStart: string, bStart: string): number {
  const diff = Math.abs(timeToMinutes(aStart) - timeToMinutes(bStart));
  return Math.min(diff, 1440 - diff);
}
const NEUTRAL_CONTINUITY_DISTANCE_MINUTES = 360; // "no data" ranks like a moderate 6h shift-time change — neither a bonus nor a penalty

/**
 * Stage 6 of the planning pipeline: assigning daily shifts to the
 * flexible General T1 ACE pool, driven by the day's aggregated demand
 * (Stage 5) rather than flight-by-flight, and driven by the day's REAL
 * required capacity rather than by employees' static baseline pattern.
 *
 * DEMAND-DRIVEN, NOT TEMPLATE-DRIVEN: every ACTIVE flexible-pool employee
 * is a candidate every day — there is no more "already off per their
 * static weekly_shifts template" pre-filter. An employee not selected by
 * this function for a given day is genuinely OFF that day (see
 * duty-generation.ts's resolvePlanRosterEntry, which no longer falls back
 * to Employee.weekly_shifts for this pool) — OFF is now a normal,
 * expected planning OUTCOME of "demand didn't need this person today,"
 * not a pre-declared template cell. This is the core Task E correction:
 * `RAM demand -> required capacity -> compatible shift coverage ->
 * roster/OFF placement`, never the reverse.
 *
 * Still a deliberate FIRST-PASS GREEDY HEURISTIC, not a full optimizer:
 *  - Roles are processed in a fixed order (Boarding, Check-in, Gate,
 *    Profiling, Mesure).
 *  - Before pulling in a new employee for a role, employees ALREADY
 *    assigned a shift today (for an earlier-processed role) are checked
 *    first for cross-role coverage — one multi-skilled employee's single
 *    shift can count toward multiple roles' demand.
 *  - RANKED SHIFT-CODE FALLBACK (new): rather than trying only the single
 *    nearest-fit catalog code for a role's demand window, up to
 *    MAX_SHIFT_CODE_CANDIDATES ranked candidates (selectCompatibleShiftCodes,
 *    nearest-fit-then-shortest-duration) are tried in order. Capacity is
 *    determined FIRST (peak/window, unchanged) — ranked codes are only
 *    ever used to find real, rest-compliant EMPLOYEES to cover that
 *    already-determined capacity, never to inflate or invent demand. A
 *    later code candidate is only tried when the current one couldn't
 *    reach peak with any remaining eligible, rested employee.
 *  - FAIRNESS ORDERING (new): among employees eligible for a given
 *    candidate code (qualified, available, rest-compliant), the greedy
 *    fill order is no longer array order — it's sorted by (1) ascending
 *    hours already assigned this week so far (spread load, don't
 *    repeatedly burden the same people), then (2) continuity: how close
 *    this code's start time is to the employee's own immediately-
 *    preceding-day start time (prefer NOT to churn someone from an early
 *    shift to a late one and back for no operational reason). Fairness
 *    only ever orders otherwise-equally-eligible candidates — it never
 *    overrides a hard qualification/rest gate, and it never causes a
 *    role to go understaffed when a less "fair" candidate could have
 *    covered it.
 *  - Stops once a role's peak demand is met or no more ranked code +
 *    eligible-employee combination is available — it does NOT attempt a
 *    joint, whole-day optimum across roles.
 *
 * Cross-day rest is part of shift SELECTION, not just after-the-fact
 * detection: `priorDayShift` carries each employee's effective shift on
 * the immediately preceding day (built by the caller as it walks the week
 * day by day — seeded from the immediately preceding WEEK's real roster,
 * or a documented fallback, for a window's own first day — see
 * rotation-context.ts). Before a candidate shift is handed to an
 * employee, it must clear the same minimum-rest rule validation.ts
 * already enforces (`restHoursBetween`). An employee who would land below
 * the minimum is simply skipped for that role/day/code: this is a real,
 * honest coverage shortfall, surfaced later as an unfilled_duty by Stage
 * 10 if nobody else can cover it — never an illegal roster silently
 * created and only flagged afterward.
 */
const MAX_SHIFT_CODE_CANDIDATES = 3;

export function generateFlexiblePoolShifts(
  dayOfWeek: string,
  demand: DailyDemand,
  allEmployees: Employee[],
  priorDayShift: PriorDayShiftMap = new Map(),
  minimumRestHours = 0,
  rolesToConsider: string[] = ["Boarding", "Check-in", "Gate", "Profiling", "Mesure"],
  // The employee's EFFECTIVE shift on the immediately FOLLOWING day, if
  // that day is never re-generated by Stage 6 itself (i.e. their own
  // static baseline for tomorrow -- the only thing knowable before
  // tomorrow has actually been processed). Without this, a shift chosen
  // for TODAY could leave an employee under-rested for tomorrow's
  // already-fixed fallback shift with nothing ever having checked that
  // specific transition (the day-by-day loop only checks backward
  // against yesterday's real shift, via priorDayShift) -- a real,
  // observed gap once the confirmed rest floor rose to 15h (see the
  // delivered report). This is a conservative, sometimes-overcautious
  // lookahead: if tomorrow ends up being separately re-generated with a
  // different, compatible code, today's rejection here was stricter than
  // strictly necessary -- but "surface a capacity shortfall" is exactly
  // what the brief asks for when no feasible combination is provable in
  // a single forward pass, rather than ever generating an illegal one.
  nextDayBaselineShift: PriorDayShiftMap = new Map(),
  // Fairness input ONLY — real hours already assigned to each employee
  // earlier THIS SAME generation run (this week), used purely to order
  // otherwise-tied greedy candidates (spread workload; never resurrect a
  // hard weekly ceiling — see lib/planning/average-hours.ts and the
  // delivered report on why a calendar-week hours gate must never
  // return). Defaults to empty (every employee starts "equally fair") so
  // every existing caller/test keeps working unchanged.
  hoursSoFarThisWeek: Map<string, number> = new Map()
): GeneratedShiftAssignment[] {
  // Every ACTIVE flexible-pool employee is a candidate today — no more
  // "already off per static weekly_shifts" pre-filter. Availability is
  // now decided entirely by whether real demand + rest + qualification
  // select them, not by a pre-declared template cell.
  const availableToday = allEmployees.filter(isFlexibleGeneralPool);

  const assignments = new Map<string, GeneratedShiftAssignment>(); // employeeId -> assignment

  for (const role of rolesToConsider) {
    // Demand for a role is rarely one continuous span across the whole
    // day (see demandClustersForRole's doc comment) — each cluster is a
    // separately coverable window, covered independently, so a morning
    // bank and an evening bank can draw on different employees rather
    // than requiring one shift to somehow span a gap no catalog code
    // covers.
    const clusters = demandClustersForRole(demand, role);

    for (const cluster of clusters) {
      const peak = cluster.peak;
      if (peak === 0) continue;
      const window = { start: cluster.start, end: cluster.end };

      // Count already-assigned employees (from an earlier role/cluster)
      // who are BOTH qualified for this role AND whose actual shift for
      // today genuinely overlaps this cluster's window — their existing
      // shift already covers it, no new assignment needed. Skill alone
      // isn't enough once a role can have multiple disjoint clusters: an
      // employee's shift might cover the morning cluster but not the
      // evening one.
      let covered = 0;
      for (const a of assignments.values()) {
        const employee = availableToday.find((e) => e.id === a.employeeId);
        if (!employee?.skills.includes(role)) continue;
        const times = getShiftTimesAs(a.shiftCode);
        if (!windowsOverlap(times.shift_start, times.shift_end, window.start, window.end)) continue;
        covered++;
        if (!a.coversRoles.includes(role)) a.coversRoles.push(role);
      }

      const candidateCodes = selectCompatibleShiftCodes(window.start, window.end).slice(0, MAX_SHIFT_CODE_CANDIDATES);

      for (const candidateCode of candidateCodes) {
        if (covered >= peak) break;

        const eligible = availableToday.filter((employee) => {
          if (covered >= peak) return false;
          if (assignments.has(employee.id)) return false; // already rostered today for another role/cluster
          if (!employee.skills.includes(role)) return false;

          const priorShift = priorDayShift.get(employee.id);
          if (priorShift && restHoursBetween(priorShift.shift_start, priorShift.shift_end, candidateCode.entree) < minimumRestHours) {
            return false;
          }
          const nextShift = nextDayBaselineShift.get(employee.id);
          if (nextShift && restHoursBetween(candidateCode.entree, candidateCode.sortie, nextShift.shift_start) < minimumRestHours) {
            return false;
          }
          return true;
        });

        // Fairness ordering ONLY among employees already proven eligible
        // above — never a substitute for the hard gates. Ascending hours
        // so far this week (spread load), then ascending continuity
        // distance from this employee's own prior-day start (prefer to
        // keep someone on a similar shift time rather than churn them).
        eligible.sort((a, b) => {
          const hoursA = hoursSoFarThisWeek.get(a.id) ?? 0;
          const hoursB = hoursSoFarThisWeek.get(b.id) ?? 0;
          if (hoursA !== hoursB) return hoursA - hoursB;

          const priorA = priorDayShift.get(a.id);
          const priorB = priorDayShift.get(b.id);
          const distA = priorA ? circularStartDistanceMinutes(priorA.shift_start, candidateCode.entree) : NEUTRAL_CONTINUITY_DISTANCE_MINUTES;
          const distB = priorB ? circularStartDistanceMinutes(priorB.shift_start, candidateCode.entree) : NEUTRAL_CONTINUITY_DISTANCE_MINUTES;
          return distA - distB;
        });

        // NOTE: there is deliberately no hours-ceiling gate here. The
        // confirmed 42h rule (lib/labor-rules.ts's
        // maximumAverageWeeklyWorkingHours) is an AVERAGE over a reference
        // period that is not yet confirmed — rejecting a candidate because
        // the DISPLAYED Monday-Sunday week would exceed 42h was treating
        // that window as the reference period, which is exactly the wrong
        // assumption this milestone corrects. hoursSoFarThisWeek above is
        // used ONLY to order fairness, never to reject anyone. See
        // lib/planning/average-hours.ts and the delivered report.

        for (const employee of eligible) {
          if (covered >= peak) break;
          assignments.set(employee.id, {
            employeeId: employee.id,
            dayOfWeek,
            shiftCode: candidateCode.code,
            coversRoles: [role],
          });
          covered++;
        }
      }
    }
  }

  return Array.from(assignments.values());
}

export interface DroppedShiftForRest {
  employeeId: string;
  dayOfWeek: string;
  shiftCode: string;
  restHours: number;
}

/**
 * Like roster-generation.ts's restHoursBetween, but for two shifts that
 * are not necessarily on literally ADJACENT calendar days —
 * restHoursBetween always assumes exactly one calendar day separates the
 * two shifts (it adds a single 24h to the next shift's start), which is
 * correct for a same-day/next-day pair but silently UNDERSTATES real rest
 * by 24h for every extra intervening OFF day skipped over (a genuine bug
 * found while building enforceRestInvariantAcrossWeek's carry-forward-
 * across-OFF-days logic below: a perfectly legal multi-day gap was being
 * misreported as a violation). `gapDays` is the number of calendar days
 * from the previous shift's OWN day to the next shift's day (1 for
 * literally adjacent days, matching restHoursBetween exactly).
 */
function restHoursBetweenAcrossGap(
  prevShiftStart: string,
  prevShiftEnd: string,
  nextShiftStart: string,
  gapDays: number
): number {
  const prevStartMin = timeToMinutes(prevShiftStart);
  let prevEndMin = timeToMinutes(prevShiftEnd);
  if (prevEndMin <= prevStartMin) prevEndMin += 24 * 60; // overnight: real end is the following calendar day
  const nextStartMin = timeToMinutes(nextShiftStart) + gapDays * 24 * 60;
  return (nextStartMin - prevEndMin) / 60;
}

/**
 * Final, whole-week HARD safety net for the 15h rest rule — a second,
 * independent enforcement layer on top of the per-day eligibility gate
 * already inside generateFlexiblePoolShifts above. The per-day gate
 * checks each candidate against the immediately preceding day's shift AT
 * THE MOMENT it's chosen; this function re-walks the ENTIRE week's real
 * outcome afterward and re-checks every consecutive pair from scratch,
 * carrying forward each employee's true LAST WORKED shift (not just
 * "yesterday") across any number of intervening OFF days. This catches
 * anything the per-day heuristic could ever miss (a future change to the
 * greedy fill order, an untested code path, a candidate ranking edge
 * case) — belt and suspenders, not a substitute for the per-day gate.
 *
 * Never mutates a violating pair into something "close enough" — a
 * shift that fails this check is DROPPED entirely (never persisted),
 * leaving that employee genuinely OFF that day. The role/day they would
 * have covered simply goes back to being real, uncovered demand — Stage
 * 9 (duty generation) runs on the REPAIRED result, so an uncovered role
 * surfaces honestly as an `unfilled_duty` issue, never a silently
 * fabricated illegal roster. This is intentionally NOT a warning-only
 * pass: a dropped shift is removed from the data itself, not flagged and
 * kept.
 *
 * `priorWeekBoundaryContext` seeds "last worked shift" for the week's own
 * Monday, exactly like generateFlexiblePoolShifts's own priorDayShift —
 * so a violation spanning the previous week's real Sunday shift into
 * this week's Monday is caught too, not just violations wholly inside
 * this displayed week.
 */
export function enforceRestInvariantAcrossWeek(
  daysOrder: string[],
  generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>,
  minimumRestHours: number,
  priorWeekBoundaryContext: PriorDayShiftMap = new Map()
): { repaired: Record<string, GeneratedShiftAssignment[]>; dropped: DroppedShiftForRest[] } {
  const repaired: Record<string, GeneratedShiftAssignment[]> = {};
  const dropped: DroppedShiftForRest[] = [];
  // Each employee's most recent REAL (kept) worked shift so far this walk,
  // ALONGSIDE the calendar day index it was worked on — deliberately NOT
  // reset to "no data" on an intervening OFF day (an OFF day always
  // provides ample rest on its own; what matters is the true last shift
  // actually worked, however many OFF days ago). The day index is what
  // lets restHoursBetweenAcrossGap compute the REAL number of elapsed
  // calendar days instead of always assuming exactly one.
  const lastRealShift = new Map<string, { shift_start: string; shift_end: string; dayIndex: number }>();
  for (const [employeeId, shift] of priorWeekBoundaryContext) {
    if (shift) lastRealShift.set(employeeId, { ...shift, dayIndex: -1 }); // the day immediately before daysOrder[0]
  }

  for (let dayIndex = 0; dayIndex < daysOrder.length; dayIndex++) {
    const day = daysOrder[dayIndex];
    const dayShifts = generatedShiftsByDay[day] ?? [];
    const keep: GeneratedShiftAssignment[] = [];

    for (const assignment of dayShifts) {
      const times = getShiftTimesAs(assignment.shiftCode);
      const prior = lastRealShift.get(assignment.employeeId);
      const rest = prior
        ? restHoursBetweenAcrossGap(prior.shift_start, prior.shift_end, times.shift_start, dayIndex - prior.dayIndex)
        : null;

      if (rest !== null && rest < minimumRestHours) {
        dropped.push({ employeeId: assignment.employeeId, dayOfWeek: day, shiftCode: assignment.shiftCode, restHours: rest });
        continue; // never persisted -- genuinely OFF today instead
      }

      keep.push(assignment);
    }

    repaired[day] = keep;
    for (const assignment of keep) {
      lastRealShift.set(assignment.employeeId, { ...getShiftTimesAs(assignment.shiftCode), dayIndex });
    }
  }

  // Intra-window cyclic wrap: this SAME displayed week's last day -> this
  // SAME displayed week's first day, exactly the same pseudo-continuity
  // approximation validation.ts's checkRestBetweenDays already applies
  // (treating the display window as if it repeats identically) -- without
  // this, the main walk above (which only ever looks BACKWARD/forward in
  // real calendar time, day 0 through day N-1) has no way to catch a
  // violation created only by wrapping the display back onto itself, and
  // checkRestBetweenDays would then report a rest_violation PlanIssue
  // this "hard" gate never actually prevented. Only meaningful for a full
  // 7-day window (see checkRestBetweenDays's own guard); a partial slice
  // has no real wrap to check. The FIRST day's shift is what gets
  // dropped on a violation, matching checkRestBetweenDays's own framing
  // (the violation is reported against the day the rest was insufficient
  // BEFORE, i.e. the wrapped-to day).
  if (daysOrder.length === 7) {
    const firstDay = daysOrder[0];
    const lastDay = daysOrder[daysOrder.length - 1];
    const stillKeptOnFirstDay = repaired[firstDay] ?? [];
    const keptOnLastDay = repaired[lastDay] ?? [];
    const survivors: GeneratedShiftAssignment[] = [];

    for (const assignment of stillKeptOnFirstDay) {
      const lastDayAssignment = keptOnLastDay.find((a) => a.employeeId === assignment.employeeId);
      if (!lastDayAssignment) {
        survivors.push(assignment);
        continue;
      }
      const lastDayTimes = getShiftTimesAs(lastDayAssignment.shiftCode);
      const firstDayTimes = getShiftTimesAs(assignment.shiftCode);
      const rest = restHoursBetweenAcrossGap(lastDayTimes.shift_start, lastDayTimes.shift_end, firstDayTimes.shift_start, 1);
      if (rest < minimumRestHours) {
        dropped.push({ employeeId: assignment.employeeId, dayOfWeek: firstDay, shiftCode: assignment.shiftCode, restHours: rest });
        continue;
      }
      survivors.push(assignment);
    }
    repaired[firstDay] = survivors;
  }

  return { repaired, dropped };
}
