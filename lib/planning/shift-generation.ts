import { Employee } from "../types";
import { DailyDemand } from "./demand-aggregation";
import { SHIFT_CODES, getShiftTimesAs } from "../shift-templates";
import { isFlexibleGeneralPool } from "./workforce-pools";
import { restHoursBetween } from "../roster-generation";

/** An employee's effective shift on the immediately preceding day, or null if they were OFF/unrostered — undefined (not in the map) means "no prior-day data available" (e.g. the first day of the week), which is never treated as a rest violation. */
export type PriorDayShiftMap = Map<string, { shift_start: string; shift_end: string } | null>;

export interface GeneratedShiftAssignment {
  employeeId: string;
  dayOfWeek: string;
  shiftCode: string;
  coversRoles: string[]; // every role this employee's single shift ended up covering AT LEAST ONE bucket of, across the day (informational — Stage 9/scoring.ts independently re-derives the actual per-flight duty assignment from shift_start/shift_end + real requirement windows, it does not read this field)
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Circular (clock-of-day) distance between two "HH:mm" start times, in
 * minutes — used only as a CONTINUITY preference (see the tie-break
 * chain below), never a hard constraint. A candidate with no known prior
 * start time gets a fixed neutral distance rather than an extreme
 * best/worst score, so "no continuity data" never out-ranks or
 * under-ranks "genuinely close continuity" / "genuinely disruptive
 * change."
 */
function circularStartDistanceMinutes(aStart: string, bStart: string): number {
  const diff = Math.abs(timeToMinutes(aStart) - timeToMinutes(bStart));
  return Math.min(diff, 1440 - diff);
}
const NEUTRAL_CONTINUITY_DISTANCE_MINUTES = 360; // "no data" ranks like a moderate 6h shift-time change — neither a bonus nor a penalty

const BUCKET_MINUTES = 30;
const BUCKETS_PER_DAY = (24 * 60) / BUCKET_MINUTES;

/**
 * Stage 6 of the planning pipeline: assigning daily shifts to the
 * flexible General T1 ACE pool, driven by the day's aggregated demand
 * (Stage 5) rather than flight-by-flight, and driven by the day's REAL
 * required capacity rather than by employees' static baseline pattern.
 *
 * DEMAND-DRIVEN, NOT TEMPLATE-DRIVEN: every ACTIVE flexible-pool employee
 * is a candidate every day — there is no "already off per their static
 * weekly_shifts template" pre-filter. An employee not selected by this
 * function for a given day is genuinely OFF that day (see
 * duty-generation.ts's resolvePlanRosterEntry, which no longer falls back
 * to Employee.weekly_shifts for this pool) — OFF is a normal, expected
 * planning OUTCOME of "demand didn't need this person today," not a
 * pre-declared template cell.
 *
 * JOINT SET-COVER, NOT FIXED-ROLE-ORDER GREEDY (replaces the earlier
 * per-role, per-cluster heuristic — see git history for the prior
 * version and the audit that led here). The core distinction this
 * algorithm exists to make:
 *
 *  - SIMULTANEOUS demand (two different roles needing coverage in the
 *    SAME 30-min bucket) genuinely needs TWO different people — one
 *    employee, however many roles they're qualified for, represents
 *    exactly one unit of human capacity per bucket. This is enforced
 *    structurally below: `remaining[bucket][role]` is tracked separately
 *    per role, and scoring a candidate never lets one bucket contribute
 *    to more than one role's remaining count for that same candidate.
 *  - SEQUENTIAL demand (Check-in needing someone 06:00-07:30, then Gate
 *    08:00-09:00, then Boarding 09:30-10:30, all on one continuous
 *    shift) is exactly what this DOES reuse one employee for — different
 *    buckets of their one shift can each count toward a different role,
 *    since a person really can do different jobs at different times of
 *    their working day. Stage 9 (scoring.ts/duty-generation.ts,
 *    unchanged) is what actually assigns each specific flight duty
 *    within an employee's shift, using genuine window overlap and
 *    per-duty non-overlap — this stage only needs to make sure enough of
 *    the RIGHT people (qualification + rest-legal shift) exist for Stage
 *    9 to succeed; it does not itself decide which specific duty an
 *    employee gets at which moment.
 *
 * ALGORITHM: a standard greedy weighted set-cover. Every (employee, legal
 * shift code) pair is a candidate "set" that could cover some of the
 * day's still-unfilled (bucket, role) demand units. Repeatedly:
 *   1. Score every remaining candidate by how many CURRENTLY-unfilled
 *      (bucket, role) units it would cover (at most one role per bucket,
 *      via the fixed rolesToConsider priority order, for that
 *      candidate — see coverageFor below).
 *   2. Take the highest-scoring candidate; tie-break by (a) shortest
 *      shift duration — don't roster someone longer than the coverage
 *      they'd actually provide needs, (b) fewest hours already assigned
 *      this week so far — spread load across otherwise-idle eligible
 *      people rather than repeatedly reusing the same ones, (c) smallest
 *      continuity distance from their own immediately-preceding-day
 *      start time, (d) employee id — for full, reproducible determinism.
 *   3. Mark those (bucket, role) units covered, remove that employee
 *      from further consideration this day, repeat.
 *   4. Stop once no remaining candidate would cover anything at all —
 *      never once a fixed target is "reached," since there is no longer
 *      a single per-role target: the target is real, aggregate,
 *      role-and-bucket-specific demand, met however many people that
 *      genuinely takes.
 *
 * A candidate's legality (rest-compliant shift code) is evaluated ONCE
 * per employee up front, independent of iteration order — rest depends
 * only on that employee's own prior/next-day shift and the candidate
 * code's own entree, never on who else has already been picked.
 * Overnight-wrapping codes are excluded from this pool entirely (same
 * scope as the previous implementation and as
 * selectCompatibleShiftCodes) — General T1 has never used them.
 *
 * Cross-day rest is part of shift SELECTION, not just after-the-fact
 * detection: `priorDayShift` carries each employee's effective shift on
 * the immediately preceding day (built by the caller as it walks the
 * week day by day — seeded from the immediately preceding WEEK's real
 * roster, or a documented fallback, for a window's own first day — see
 * rotation-context.ts). A candidate code that would land an employee
 * below the confirmed minimum rest, against EITHER the immediately
 * preceding day's real shift or the immediately following day's own
 * (not-yet-regenerated) baseline shift, is never offered to them at all.
 * `enforceRestInvariantAcrossWeek` below remains the final, independent,
 * whole-week hard safety net on top of this per-day legality gate.
 */
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

  // Remaining demand, per bucket per role — a mutable working copy of
  // this day's aggregated demand, restricted to the roles this call is
  // responsible for (Profiling/Mesure/foreign teams have their own
  // separate generation, see specialized-team-generation.ts; this
  // function is never handed their demand, but the filter is kept
  // explicit and cheap rather than assumed from the caller).
  const remaining: Map<string, number>[] = demand.buckets.map((bucket) => {
    const m = new Map<string, number>();
    for (const role of rolesToConsider) {
      const need = bucket.demandByRole[role] ?? 0;
      if (need > 0) m.set(role, need);
    }
    return m;
  });

  // Every catalog shift code, precomputed once (non-overnight only — see
  // doc comment above).
  const allCodes = Object.entries(SHIFT_CODES)
    .map(([code, { entree, sortie }]) => ({ code, entreeMin: timeToMinutes(entree), sortieMin: timeToMinutes(sortie) }))
    .filter((c) => c.sortieMin > c.entreeMin);

  // Which buckets a given code's shift genuinely COVERS -- deliberately
  // ASYMMETRIC, matching scoring.ts's own asymmetric duty-eligibility
  // rule exactly: a shift starting partway through a bucket still counts
  // (this is allowLateStart's whole point from the earlier fix -- an
  // employee arriving mid-window is real, usable coverage for the rest
  // of it), but a shift that LEAVES partway through a bucket does NOT.
  // Before this fix, plain overlap (entreeMin < bucketEnd && bucketStart
  // < sortieMin) credited a shift ending even one minute into a bucket
  // as if it covered that bucket in full -- so a shift ending at 22:45
  // scored identically to one ending at 23:15 for a bucket spanning
  // 22:30-23:00, and the duration tie-break then picked the SHORTER one,
  // even though it leaves 15 minutes before the requirement's own close.
  // scoring.ts (Stage 9) correctly refuses to treat that as full coverage
  // (its own doc comment: a shift ending before the window ends is
  // flagged, never silently recommended) -- Stage 6 must not claim
  // capacity Stage 9 will correctly refuse. This is NOT a new
  // "allowEarlyEnd" concept and does not touch the start side at all:
  // only the end condition changed, from `bucketStart < sortieMin`
  // (any overlap) to `sortieMin >= bucketEnd` (present through the
  // bucket's full close).
  function bucketsCoveredBy(entreeMin: number, sortieMin: number): number[] {
    const covered: number[] = [];
    for (let i = 0; i < BUCKETS_PER_DAY; i++) {
      const bucketStart = i * BUCKET_MINUTES;
      const bucketEnd = bucketStart + BUCKET_MINUTES;
      if (entreeMin < bucketEnd && sortieMin >= bucketEnd) covered.push(i);
    }
    return covered;
  }

  // Per-employee legal (rest-compliant) codes, computed once up front —
  // legality depends only on this employee's own prior/next-day shift
  // and a candidate code's own entree/sortie, never on which other
  // employees end up chosen this same day.
  const legalCodesByEmployee = new Map<string, { code: string; entreeMin: number; sortieMin: number }[]>();
  for (const employee of availableToday) {
    const priorShift = priorDayShift.get(employee.id);
    const nextShift = nextDayBaselineShift.get(employee.id);
    const legal = allCodes.filter((c) => {
      if (priorShift) {
        const entreeTime = `${String(Math.floor(c.entreeMin / 60)).padStart(2, "0")}:${String(c.entreeMin % 60).padStart(2, "0")}`;
        if (restHoursBetween(priorShift.shift_start, priorShift.shift_end, entreeTime) < minimumRestHours) return false;
      }
      if (nextShift) {
        const entreeTime = `${String(Math.floor(c.entreeMin / 60)).padStart(2, "0")}:${String(c.entreeMin % 60).padStart(2, "0")}`;
        const sortieTime = `${String(Math.floor(c.sortieMin / 60)).padStart(2, "0")}:${String(c.sortieMin % 60).padStart(2, "0")}`;
        if (restHoursBetween(entreeTime, sortieTime, nextShift.shift_start) < minimumRestHours) return false;
      }
      return true;
    });
    if (legal.length > 0) legalCodesByEmployee.set(employee.id, legal);
  }

  const assignments = new Map<string, GeneratedShiftAssignment>();
  const assignedIds = new Set<string>();

  for (;;) {
    let best: {
      employee: Employee;
      code: string;
      entreeMin: number;
      sortieMin: number;
      score: number;
      bucketRoles: { bucket: number; role: string }[];
    } | null = null;

    for (const employee of availableToday) {
      if (assignedIds.has(employee.id)) continue;
      const legalCodes = legalCodesByEmployee.get(employee.id);
      if (!legalCodes) continue;

      for (const candidate of legalCodes) {
        const buckets = bucketsCoveredBy(candidate.entreeMin, candidate.sortieMin);
        let score = 0;
        const bucketRoles: { bucket: number; role: string }[] = [];
        for (const bucket of buckets) {
          // One employee = one unit of capacity per bucket, however many
          // roles they're qualified for: pick at most ONE role per
          // bucket for THIS candidate, in the fixed rolesToConsider
          // priority order, among roles the employee is actually
          // qualified for AND that still have unmet demand.
          for (const role of rolesToConsider) {
            if (!employee.skills.includes(role)) continue;
            if ((remaining[bucket].get(role) ?? 0) <= 0) continue;
            score++;
            bucketRoles.push({ bucket, role });
            break;
          }
        }
        if (score === 0) continue;

        if (!best || isBetterCandidate(employee, candidate, score, best)) {
          best = { employee, code: candidate.code, entreeMin: candidate.entreeMin, sortieMin: candidate.sortieMin, score, bucketRoles };
        }
      }
    }

    if (!best) break; // no remaining candidate covers anything — genuine capacity/demand exhaustion

    for (const { bucket, role } of best.bucketRoles) {
      remaining[bucket].set(role, (remaining[bucket].get(role) ?? 0) - 1);
    }
    assignedIds.add(best.employee.id);
    assignments.set(best.employee.id, {
      employeeId: best.employee.id,
      dayOfWeek,
      shiftCode: best.code,
      coversRoles: Array.from(new Set(best.bucketRoles.map((br) => br.role))),
    });
  }

  function isBetterCandidate(
    employee: Employee,
    candidate: { code: string; entreeMin: number; sortieMin: number },
    score: number,
    current: { employee: Employee; entreeMin: number; sortieMin: number; score: number }
  ): boolean {
    if (score !== current.score) return score > current.score;

    const durationA = candidate.sortieMin - candidate.entreeMin;
    const durationB = current.sortieMin - current.entreeMin;
    if (durationA !== durationB) return durationA < durationB; // shortest shift that achieves the same coverage

    const hoursA = hoursSoFarThisWeek.get(employee.id) ?? 0;
    const hoursB = hoursSoFarThisWeek.get(current.employee.id) ?? 0;
    if (hoursA !== hoursB) return hoursA < hoursB; // spread load — prefer an otherwise-idle eligible person

    const entreeTimeA = `${String(Math.floor(candidate.entreeMin / 60)).padStart(2, "0")}:${String(candidate.entreeMin % 60).padStart(2, "0")}`;
    const entreeTimeB = `${String(Math.floor(current.entreeMin / 60)).padStart(2, "0")}:${String(current.entreeMin % 60).padStart(2, "0")}`;
    const priorA = priorDayShift.get(employee.id);
    const priorB = priorDayShift.get(current.employee.id);
    const distA = priorA ? circularStartDistanceMinutes(priorA.shift_start, entreeTimeA) : NEUTRAL_CONTINUITY_DISTANCE_MINUTES;
    const distB = priorB ? circularStartDistanceMinutes(priorB.shift_start, entreeTimeB) : NEUTRAL_CONTINUITY_DISTANCE_MINUTES;
    if (distA !== distB) return distA < distB;

    return employee.id < current.employee.id; // final, fully deterministic tie-break
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
/**
 * The single authoritative "actual rest hours before this employee's
 * shift on this day" value, keyed `${employeeId}|${dayOfWeek}`. Computed
 * ONCE, here, from the same real walk enforceRestInvariantAcrossWeek
 * already does to decide keep/drop — this is not a second rest
 * calculation, it's the first one's own working values, exposed. Every
 * consumer that needs to know "is this employee actually rested for
 * their real generated/persisted shift" (Stage 9's scoreCandidates,
 * lib/scoring.ts) reads from THIS map instead of the employee's static,
 * persisted `rest_before_shift_hours` field, which reflects whatever
 * their OLD baseline template implied and goes stale the moment
 * demand-driven generation puts them on a different real shift.
 *
 * `Number.POSITIVE_INFINITY` means "no real prior-shift data to check
 * against" (the same "undefined prior shift is never a violation"
 * convention used everywhere else in this pipeline) -- never a
 * fabricated pass, just an honest "nothing contradicts rest here."
 */
export type ActualRestHoursByEmployeeDay = Map<string, number>;

function restKey(employeeId: string, dayOfWeek: string): string {
  return `${employeeId}|${dayOfWeek}`;
}

export function enforceRestInvariantAcrossWeek(
  daysOrder: string[],
  generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>,
  minimumRestHours: number,
  priorWeekBoundaryContext: PriorDayShiftMap = new Map(),
  // Employee IDs whose day-by-day placement is DEMAND-DRIVEN (General T1,
  // Profiling, Mesure, foreign companies) rather than a confirmed,
  // genuinely-repeating fixed rotation (Transit/Leaders/Duty Officers,
  // etc. -- see teams.ts). Only changes behavior in the WRAPAROUND check
  // below (this week's own last day -> this week's own first day): for a
  // fixed team, that pattern really does repeat every week by design, so
  // a conflict there is confirmed and stays a hard drop, exactly as
  // before. For a demand-driven population, next week's actual schedule
  // is generated fresh from next week's own flight demand and isn't
  // known yet -- "this week repeats" is a hypothesis, not a fact, so a
  // conflict there is no longer silently dropped: the shift is kept, and
  // checkRestBetweenDays (validation.ts, which runs afterward on the
  // persisted roster) surfaces it as a visible cross_week_continuity_
  // uncertain WARNING instead — never a hard, blocking rest_violation
  // over an assumption nobody has confirmed. Defaults to empty (every
  // employee treated as fixed -- the original hard-drop behavior) so
  // every existing caller/test keeps working unchanged.
  generationDrivenEmployeeIds: Set<string> = new Set()
): { repaired: Record<string, GeneratedShiftAssignment[]>; dropped: DroppedShiftForRest[]; restHoursByEmployeeDay: ActualRestHoursByEmployeeDay } {
  const repaired: Record<string, GeneratedShiftAssignment[]> = {};
  const dropped: DroppedShiftForRest[] = [];
  const restHoursByEmployeeDay: ActualRestHoursByEmployeeDay = new Map();
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
      restHoursByEmployeeDay.set(restKey(assignment.employeeId, day), rest ?? Number.POSITIVE_INFINITY);
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
        if (generationDrivenEmployeeIds.has(assignment.employeeId)) {
          // Kept, not dropped -- see this function's doc comment. The low
          // wraparound rest value is deliberately NOT written into
          // restHoursByEmployeeDay here (it stays whatever the main walk
          // already set, typically Number.POSITIVE_INFINITY when no real
          // priorWeekBoundaryContext exists) -- Stage 9 must treat this
          // employee as eligible, since the whole point of not dropping
          // the shift is that we are NOT enforcing this unconfirmed
          // assumption as a hard constraint. checkRestBetweenDays is what
          // surfaces the finding, visibly, as a warning.
          survivors.push(assignment);
          continue;
        }
        dropped.push({ employeeId: assignment.employeeId, dayOfWeek: firstDay, shiftCode: assignment.shiftCode, restHours: rest });
        restHoursByEmployeeDay.delete(restKey(assignment.employeeId, firstDay));
        continue;
      }
      // This wrap check is a REAL, additional constraint against this
      // same week's own last day -- whichever of it and the main walk's
      // own day-0 value (against priorWeekBoundaryContext) is LOWER is
      // the genuinely binding one; both must hold simultaneously, so the
      // authoritative "actual rest" value is never higher than either.
      const existing = restHoursByEmployeeDay.get(restKey(assignment.employeeId, firstDay)) ?? Number.POSITIVE_INFINITY;
      restHoursByEmployeeDay.set(restKey(assignment.employeeId, firstDay), Math.min(existing, rest));
      survivors.push(assignment);
    }
    repaired[firstDay] = survivors;
  }

  return { repaired, dropped, restHoursByEmployeeDay };
}
