import { Employee, Config } from "../types";
import { GeneratedShiftAssignment, PriorDayShiftMap } from "./shift-generation";
import { isFlexibleGeneralPool } from "./workforce-pools";
import { SHIFT_CODES, getShiftTimesAs, getShiftDurationHours } from "../shift-templates";
import { restHoursBetween } from "../roster-generation";

/**
 * STAGE: CONTINUOUS ROSTER GENERATION — sits BEFORE shift assignment
 * (lib/planning/shift-generation.ts's generateFlexiblePoolShifts and
 * specialized-team-generation.ts) in the conceptual pipeline the product
 * owner asked for:
 *
 *   1. Workforce obligation/history
 *   2. Continuous roster generation  <-- this module
 *   3. Shift assignment
 *   4. Protected/specialized commitments
 *   5. Available capacity timeline
 *   6. Operational duty allocation
 *   7. Validation
 *
 * Its job is the "roster planning" half of the split documented in
 * docs/known-limitations/roster-planning-vs-duty-allocation.md: deciding
 * WHICH DAYS an employee is rostered-on AT ALL, driven by their real
 * working-hours obligation (once confirmed — see lib/labor-rules.ts's
 * workingHoursObligationHours / lib/planning/roster-obligation.ts) + the
 * confirmed 15h rest floor + OFF-day rules
 * (lib/planning/consecutive-off.ts, lib/labor-rules.ts) + cross-week
 * continuity (lib/planning/rotation-context.ts) — NOT purely flight
 * demand, which is what Stage 6/duty allocation already does correctly
 * (see shift-generation.ts's own doc comment on this exact limitation).
 *
 * NARROWED BACKWARD-COMPATIBILITY CONTRACT (revised — see
 * docs/known-limitations/roster-planning-vs-duty-allocation.md's
 * "5 WORK + 2 OFF, independent of demand" confirmed rule, and
 * lib/labor-rules.ts's normalWeeklyOffDays): this module is STILL a
 * complete NO-OP for anything it doesn't apply to — non-flexible, fixed-
 * cycle (Transit/Leaders/Duty Officers), foreign-company, and Profiling/
 * Mesure populations are entirely untouched, exactly as before (the
 * `employees.filter(isFlexibleGeneralPool)` gate below is unchanged).
 *
 * But it is NO LONGER a no-op for the general flexible ACE pool merely
 * because `config.working_hours_obligation_hours` is `null`. Two
 * genuinely separate top-up objectives are layered here, on top of (never
 * instead of) Stage 6's demand-driven result:
 *
 *  1. CONFIRMED, ALWAYS-ON — "5 WORK + 2 OFF, independent of demand"
 *     (product owner, confirmed as a rule, not a number to guess): every
 *     active flexible ACE is topped up toward `daysOrder.length -
 *     config.normal_weekly_off_days` worked days in this window
 *     (`config.normal_weekly_off_days` is already confirmed at 2 — see
 *     labor-rules.ts — so this is NOT a new config field, just this
 *     stage finally enforcing what that number already means for a
 *     7-day window). This runs UNCONDITIONALLY for the flexible pool,
 *     regardless of whether the hours-obligation number below is ever
 *     configured. This is a genuine, intentional behavior change from
 *     the previous fully-gated no-op: a flexible ACE can no longer
 *     legitimately end up OFF all week (or working only 1-2 days) purely
 *     because demand alone didn't justify more.
 *  2. STILL UNCONFIRMED, STILL GATED — the weekly-hours obligation
 *     top-up: while `config.working_hours_obligation_hours` stays `null`
 *     (today's real-world default), no additional day is ever added
 *     purely to chase an hours target — only objective 1 above can add a
 *     day while the hours number is unconfigured. Once a real number IS
 *     configured, this stage ALSO tops up hours toward the pro-rated
 *     target, using the SAME day-count ceiling as objective 1 (an
 *     employee is never scheduled below the confirmed OFF-day
 *     entitlement to chase either objective).
 *
 * A day added here (for either objective) is a real, honest "working,
 * available capacity" day — not a fabricated flight duty; Stage 9
 * (duty-generation.ts) is free to fill part of it with real work, or
 * leave it as genuine idle/available capacity, exactly as the
 * known-limitations doc describes.
 *
 * SOFT PREFERENCE — CONSECUTIVE OFF DAYS (Part 2, confirmed as a
 * preference, never a hard constraint): when choosing WHICH currently-
 * free days to top up (objective 1 above), this stage prefers to leave
 * the remaining OFF days as one CONSECUTIVE block (e.g. Sat/Sun) rather
 * than scattering them (e.g. Tue + Fri) — see
 * chooseTopUpDayPreferenceOrder below. This is a pure ordering
 * preference: it never creates a staffing gap, never refuses a legal
 * separated-OFF outcome when consecutive isn't achievable (rest,
 * qualifications, or the demand-driven days themselves already force a
 * split), and a separated result remains fully legal — see
 * lib/planning/validation.ts's `separated_off_days` PlanIssue, which
 * surfaces this as a non-blocking recommendation, never a validation
 * failure.
 *
 * This function never overrides or removes a demand-driven day, never
 * pushes an employee below the confirmed minimum OFF days
 * (`config.normal_weekly_off_days`) for this displayed window, and never
 * offers an illegal (rest-violating) shift — a day it can't legally cover
 * is simply left as a real shortfall, exactly like every other honest-gap
 * convention in this codebase (see specialized-team-generation.ts's
 * DemandConflict). The universal whole-week rest safety net
 * (shift-generation.ts's enforceRestInvariantAcrossWeek) still
 * re-validates everything this stage adds, as the final backstop, same
 * as every other generation source.
 */

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Non-overnight catalog codes, shortest duration first — a top-up should
// add the MINIMUM extra legal time needed to close the shortfall, never
// the longest available shift, since there is no real demand driving how
// long this day should be; the employee's own obligation is the only
// thing being satisfied here.
function shortestFirstCatalogCodes(): { code: string; entreeMin: number; sortieMin: number }[] {
  return Object.entries(SHIFT_CODES)
    .map(([code, { entree, sortie }]) => ({ code, entreeMin: timeToMinutes(entree), sortieMin: timeToMinutes(sortie) }))
    .filter((c) => c.sortieMin > c.entreeMin)
    .sort((a, b) => a.sortieMin - a.entreeMin - (b.sortieMin - b.entreeMin));
}

/**
 * Pro-rates `config.working_hours_obligation_hours` onto a window of
 * `windowDays` calendar days. The obligation is confirmed to be defined
 * over `config.working_hours_obligation_reference_period_days` days (see
 * lib/types.ts's Config doc comment) — while THAT is also null (i.e. only
 * the flat number is configured, with no horizon confirmed yet), this
 * treats the obligation as already scoped to exactly this window, the
 * most conservative reading (never silently stretches or shrinks an
 * unconfirmed horizon). Returns null when the obligation itself isn't
 * configured — callers must treat null as "this stage is a no-op," never
 * as "the target is 0."
 */
export function proratedObligationHoursForWindow(config: Config, windowDays: number): number | null {
  if (config.working_hours_obligation_hours === null) return null;
  const referenceDays = config.working_hours_obligation_reference_period_days;
  if (referenceDays === null || referenceDays <= 0) return config.working_hours_obligation_hours;
  return (config.working_hours_obligation_hours / referenceDays) * windowDays;
}

/**
 * Decides, among a flexible ACE's currently-free (not demand-driven)
 * days, which ones this stage should PREFER to top up first, so that
 * whichever free days are left un-topped-up (i.e. remain genuinely OFF)
 * tend to form one CONSECUTIVE block of `offDaysTarget` days — the soft
 * preference confirmed in Part 2 of the product owner's guidance.
 *
 * Pure ordering preference, never a constraint: the caller still applies
 * the exact same rest-legality gate to every day in the returned order,
 * so a day this function put last can still end up filled (if earlier
 * days turn out illegal) and a day it put first can still end up
 * skipped (if it's illegal) — this only ever changes WHICH free days are
 * attempted first when there's a real choice, never what's legal.
 *
 * Algorithm: find the cyclic (wraparound-aware, matching
 * lib/planning/consecutive-off.ts's maxConsecutiveOffCyclic convention)
 * window of `offDaysTarget` consecutive calendar days that contains the
 * MOST free days (ties broken by earliest start, for determinism) — that
 * window is the best available "keep OFF" candidate. Every free day
 * OUTSIDE that window is returned first (in calendar order, to top up),
 * followed by the free days INSIDE the window (reserved, tried only if
 * still needed after every non-reserved free day has been considered).
 */
export function chooseTopUpReservedOffDays(daysOrder: string[], freeDays: ReadonlySet<string>, offDaysTarget: number): Set<string> {
  const freeDaysInOrder = daysOrder.filter((d) => freeDays.has(d));
  if (offDaysTarget <= 0 || freeDaysInOrder.length <= offDaysTarget) {
    // Nothing to reserve — either no OFF entitlement to preserve, or
    // there aren't even enough free days to exceed it, so every free day
    // is a genuine top-up candidate with no "reserved" set to protect.
    return new Set();
  }

  const n = daysOrder.length;
  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start < n; start++) {
    let score = 0;
    for (let k = 0; k < offDaysTarget; k++) {
      if (freeDays.has(daysOrder[(start + k) % n])) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  const reserved = new Set<string>();
  for (let k = 0; k < offDaysTarget; k++) {
    const day = daysOrder[(bestStart + k) % n];
    if (freeDays.has(day)) reserved.add(day);
  }
  return reserved;
}

/**
 * The continuous-roster-generation stage itself. Returns, per day, the
 * ADDITIONAL flexible-pool shift assignments needed to (1) reach the
 * confirmed "5 WORK + 2 OFF" normal roster target, ALWAYS (see this
 * module's doc comment, objective 1), and (2) once configured, move each
 * employee toward their working-hours obligation for this window
 * (objective 2) — never a replacement for `demandDrivenShiftsByDay`,
 * which the caller must merge this output on top of (a day already
 * present in `demandDrivenShiftsByDay` for an employee is left untouched
 * here; this function only ever ADDS a day that demand alone did not
 * justify).
 */
export function generateObligationToppedUpShifts(
  daysOrder: string[],
  employees: Employee[],
  demandDrivenShiftsByDay: Record<string, GeneratedShiftAssignment[]>,
  config: Config,
  priorWeekBoundaryContext: PriorDayShiftMap,
  minimumRestHours: number
): Record<string, GeneratedShiftAssignment[]> {
  const additional: Record<string, GeneratedShiftAssignment[]> = {};
  for (const day of daysOrder) additional[day] = [];

  // Objective 2's target — null (unconfirmed) means objective 2 never
  // adds anything; objective 1 below runs regardless.
  const targetHoursThisWindow = proratedObligationHoursForWindow(config, daysOrder.length);

  const flexiblePool = employees.filter(isFlexibleGeneralPool);
  const catalogCodes = shortestFirstCatalogCodes();
  // Never schedule below the confirmed OFF-day entitlement for this
  // displayed window, for EITHER objective — the same ceiling governs
  // both, so an hours top-up can never push an employee past the
  // "5 WORK + 2 OFF" shape objective 1 already establishes.
  const targetWorkingDaysThisWindow = Math.max(0, daysOrder.length - config.normal_weekly_off_days);

  for (const employee of flexiblePool) {
    const scheduledDays = new Set<string>(
      daysOrder.filter((d) => (demandDrivenShiftsByDay[d] ?? []).some((g) => g.employeeId === employee.id))
    );

    let scheduledHours = 0;
    for (const day of scheduledDays) {
      const g = (demandDrivenShiftsByDay[day] ?? []).find((x) => x.employeeId === employee.id)!;
      scheduledHours += getShiftDurationHours(g.shiftCode);
    }

    let shortfallHours = targetHoursThisWindow === null ? 0 : Math.max(0, targetHoursThisWindow - scheduledHours);
    const daysAlreadyMetTarget = scheduledDays.size >= targetWorkingDaysThisWindow;
    if (shortfallHours <= 0 && daysAlreadyMetTarget) continue; // both objectives already satisfied by demand alone

    // Soft preference (Part 2): among this employee's currently-free
    // days, compute ONCE which ones are the best available consecutive-
    // OFF block to try to preserve — this set never changes as days get
    // filled below (recomputing it mid-walk would let an early fill
    // destabilize which block is "best" and defeat the whole point of
    // preferring one stable, consolidated block).
    const freeDays = new Set(daysOrder.filter((d) => !scheduledDays.has(d)));
    const reservedOffDays = chooseTopUpReservedOffDays(daysOrder, freeDays, config.normal_weekly_off_days);

    function attemptDay(i: number, allowReserved: boolean): boolean {
      const day = daysOrder[i];
      if (!freeDays.has(day)) return false; // already scheduled (demand-driven or topped up earlier this walk)
      // The single ceiling governing BOTH objectives: objective 1 (the
      // "5 WORK + 2 OFF" day-count target) wants exactly this many days,
      // and objective 2 (hours) is never allowed past it either — so
      // there is nothing more to add, for either objective, once it's
      // reached, regardless of whether shortfallHours has also hit 0.
      // Below the ceiling, objective 1 alone is enough reason to keep
      // adding days even once shortfallHours is already 0.
      if (scheduledDays.size >= targetWorkingDaysThisWindow) return false;

      if (reservedOffDays.has(day) && !allowReserved) return false; // leave OFF for now — preferred consecutive block

      // FORWARD lookahead against tomorrow's REAL demand-driven shift, if
      // one already exists (the same forward-half-of-the-rest-check
      // reasoning as shift-generation.ts's own nextDayBaselineShift):
      // without this, a top-up shift added here could leave the
      // immediately following day's already-fixed demand-driven shift
      // under-rested. Left unguarded, the universal whole-week safety net
      // (enforceRestInvariantAcrossWeek) would still catch the resulting
      // violation -- but since it walks strictly forward, it would drop
      // the LATER (real, demand-justified) shift rather than this
      // synthetic top-up one, silently trading away genuine coverage for
      // a top-up. Checking it here means this stage only ever adds a day
      // when doing so is compatible with what's already real, never at
      // the expense of it.
      const priorShift = resolvePriorShift(i);
      const nextDay = daysOrder[i + 1];
      const nextFixed = nextDay ? (demandDrivenShiftsByDay[nextDay] ?? []).find((x) => x.employeeId === employee.id) : undefined;
      const nextFixedShift = nextFixed ? getShiftTimesAs(nextFixed.shiftCode) : null;

      const legal = catalogCodes.find((c) => {
        if (priorShift) {
          const entreeTime = minutesToTime(c.entreeMin);
          if (restHoursBetween(priorShift.shift_start, priorShift.shift_end, entreeTime) < minimumRestHours) return false;
        }
        if (nextFixedShift) {
          const entreeTime = minutesToTime(c.entreeMin);
          const sortieTime = minutesToTime(c.sortieMin);
          if (restHoursBetween(entreeTime, sortieTime, nextFixedShift.shift_start) < minimumRestHours) return false;
        }
        return true;
      });

      if (!legal) return false; // no legally-rested shift available today — leave the honest gap, try the next candidate day

      additional[day].push({ employeeId: employee.id, dayOfWeek: day, shiftCode: legal.code, coversRoles: [] });
      scheduledDays.add(day);
      freeDays.delete(day);
      shortfallHours = Math.max(0, shortfallHours - getShiftDurationHours(legal.code));
      return true;
    }

    // Each employee's effective prior shift immediately BEFORE day index
    // i — the immediately preceding day's real demand-driven shift or
    // already-added top-up shift, or null if that preceding day is a
    // genuine OFF day (which always resets rest fully, exactly like the
    // rest of this pipeline's day-by-day walks), or the seeded prior-week
    // boundary shift for the window's own first day.
    function resolvePriorShift(i: number): { shift_start: string; shift_end: string } | null {
      if (i === 0) return priorWeekBoundaryContext.get(employee.id) ?? null;
      const day = daysOrder[i - 1];
      const demandShift = (demandDrivenShiftsByDay[day] ?? []).find((x) => x.employeeId === employee.id);
      if (demandShift) return getShiftTimesAs(demandShift.shiftCode);
      const addedShift = additional[day].find((x) => x.employeeId === employee.id);
      if (addedShift) return getShiftTimesAs(addedShift.shiftCode);
      return null; // preceding day is a genuine OFF day
    }

    // Pass 1: every free day NOT in the preferred reserved block —
    // consolidating the remaining OFF days into that block wherever
    // legality allows.
    for (let i = 0; i < daysOrder.length; i++) {
      if (!freeDays.has(daysOrder[i])) continue; // already scheduled (demand-driven)
      attemptDay(i, false);
    }
    // Pass 2: if the normal-target / obligation shortfall still isn't
    // met, fall back to the reserved (preferred-OFF) days too — a real
    // shortfall against either objective is never left unresolved just
    // to protect the soft consecutive-OFF preference.
    if (shortfallHours > 0 || scheduledDays.size < targetWorkingDaysThisWindow) {
      for (let i = 0; i < daysOrder.length; i++) {
        if (!freeDays.has(daysOrder[i])) continue;
        attemptDay(i, true);
      }
    }

    // CYCLIC WRAP SAFETY CHECK (Sunday -> following Monday, matching
    // enforceRestInvariantAcrossWeek's own wraparound convention): the
    // sequential day-by-day walk above only ever checks a day against its
    // immediate calendar neighbor WITHIN this window (plus the seeded
    // prior-WEEK boundary for day 0) — it never checks the window's own
    // LAST day against its own FIRST day, since that pair isn't adjacent
    // in the walk's index order. A top-up shift THIS stage adds on either
    // end could still create an illegal wraparound rest gap that nothing
    // else in this function ever tested. Unlike checkRestBetweenDays'
    // softer cross_week_continuity_uncertain treatment (an unconfirmed
    // HYPOTHESIS about how next week repeats this week's pattern), a
    // violation caused by TWO DAYS THIS SAME STAGE ITSELF JUST ADDED is
    // not a hypothesis — it is a shift this stage is directly responsible
    // for, so it is corrected here, hard, by dropping whichever end this
    // stage added (never a real demand-driven day, which this stage must
    // never touch) rather than left for a softer warning to merely
    // describe. If neither end is a top-up addition (both real,
    // demand-driven), any wraparound issue there is pre-existing and
    // outside this stage's responsibility — left exactly as-is, same as
    // before this stage existed.
    if (daysOrder.length === 7) {
      const firstDay = daysOrder[0];
      const lastDay = daysOrder[daysOrder.length - 1];
      const firstShift = (demandDrivenShiftsByDay[firstDay] ?? []).find((x) => x.employeeId === employee.id) ?? additional[firstDay].find((x) => x.employeeId === employee.id);
      const lastShift = (demandDrivenShiftsByDay[lastDay] ?? []).find((x) => x.employeeId === employee.id) ?? additional[lastDay].find((x) => x.employeeId === employee.id);
      if (firstShift && lastShift) {
        const firstTimes = getShiftTimesAs(firstShift.shiftCode);
        const lastTimes = getShiftTimesAs(lastShift.shiftCode);
        const wrapRest = restHoursBetween(lastTimes.shift_start, lastTimes.shift_end, firstTimes.shift_start);
        if (wrapRest < minimumRestHours) {
          const lastIsTopUp = additional[lastDay].some((x) => x.employeeId === employee.id);
          const firstIsTopUp = additional[firstDay].some((x) => x.employeeId === employee.id);
          if (lastIsTopUp) {
            additional[lastDay] = additional[lastDay].filter((x) => x.employeeId !== employee.id);
          } else if (firstIsTopUp) {
            additional[firstDay] = additional[firstDay].filter((x) => x.employeeId !== employee.id);
          }
          // Neither top-up — a pre-existing demand-driven wraparound
          // finding, unrelated to and unresolved by this stage, exactly
          // as before this stage existed.
        }
      }
    }
  }

  return additional;
}
