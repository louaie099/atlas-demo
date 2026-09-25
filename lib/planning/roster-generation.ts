import { Employee, Config } from "../types";
import { GeneratedShiftAssignment, PriorDayShiftMap } from "./shift-generation";
import { isFlexibleGeneralPool } from "./workforce-pools";
import { getShiftTimesAs, getShiftDurationHours, shiftCatalogForDate } from "../shift-templates";
import { restHoursBetween } from "../roster-generation";
import { flightDateFor } from "../flight-date";
import { chooseBestCyclicWindowStart, cyclicWindowDays, preferredWindowStart } from "./off-window";
import { FatigueConfig } from "../fatigue-config";
import { unknownFatigueState, transitionBurdenForSpans, spanFromResolvedTimes } from "./fatigue-model";
import { projectFatigueForShift, explainFatigueChoice, shiftSpanOnDate, LastWorkedShift, FatigueCandidateProjection } from "./fatigue-planning";
import { fatigueScoreSteps } from "./stage6-score-tiers";
import { maxConsecutiveOffCyclic } from "./consecutive-off";
import { HardWorkCaps, HardCapExclusion, HardCapExclusionReason, consecutiveRunLengthIfWorked, wouldExceedHardWeeklyHoursCap } from "./hard-work-caps";
import { CapAwareRosterTarget, computeCapAwareTargetWorkDays, preferredOffWindowLength } from "./roster-target";

/**
 * HARD WORK CAPS for one employee's top-up (2026-09-25, hard-constraints
 * milestone phase 1 — see hard-work-caps.ts). `incomingStreak` is the
 * employee's consecutive-work-day streak entering the window's first day
 * (consecutive-days-continuity.ts's incomingStreakForHardCap). The weekly
 * hours side reuses computeEmployeeDayCountTopUp's own
 * `initialScheduledHours` plus whatever it adds. `shortfallOut`, when given,
 * receives each still-free day that had a rest-legal code but was closed
 * off by a cap while the day-count target remained unmet.
 */
export interface TopUpHardCaps {
  caps: HardWorkCaps;
  incomingStreak: number;
  shortfallOut?: { day: string; reason: HardCapExclusionReason }[];
  /**
   * The confirmed max-consecutive-OFF rule (config.max_consecutive_off_days).
   * Only consulted once a hard cap has actually closed a rest-legal code
   * during this employee's search: the bounded pass-1 search then prefers,
   * among equally-large partial assignments, one whose remaining OFF days do
   * not form a longer consecutive block than this (cyclic, like
   * validation.ts's check). A pure tie-break between equally-legal outcomes
   * — never adds a day, never relaxes a cap. Without it, a cap-limited
   * 4-work-day week tended to leave all 3 OFF days adjacent.
   */
  maxConsecutiveOffDays?: number;
}

/**
 * FATIGUE OPTION for the Stage-6.5 top-up (2026-09-24, fatigue milestone
 * part 2). When `config.enabled` is true, computeEmployeeDayCountTopUp
 * orders a day's legal candidate codes by LOWER fatigue burden — this
 * code's own burden on the day's REAL date (getShiftTimesAs) plus the
 * transition cost from the employee's previous worked shift and into
 * their next worked shift inside the window, quantized with
 * stage6-score-tiers.ts's fatigueScoreSteps — placed strictly BELOW the
 * existing preferences (T1-peak coverage, then the OFF/OFF-aware
 * neighbour-feasibility preference): it only reorders codes those leave
 * tied, and never adds, removes or legalizes a code. `reasonsOut`, when
 * supplied, receives day -> explainFatigueFactors labels for each day this
 * call adds (vs the code the ordering would have preferred without
 * fatigue; [] when fatigue changed nothing). Omitted / disabled = exact
 * prior behaviour.
 */
export interface TopUpFatigueOptions {
  config: FatigueConfig;
  reasonsOut?: Map<string, string[]>;
}

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

/**
 * Node cap for the Stage-6.5 top-up's bounded pass-1 backtracking search
 * (see computeEmployeeDayCountTopUp). At most 7 days x ~10 catalog codes
 * per employee; in practice the first (greedy) leaf succeeds for almost
 * everyone and the search visits a handful of nodes. The cap only bounds
 * pathological cases — never a correctness knob.
 */
const TOP_UP_SEARCH_NODE_BUDGET = 500;

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// Non-overnight catalog codes, shortest duration first — a top-up should
// add the MINIMUM extra legal time needed to close the shortfall, never
// the longest available shift, since there is no real demand driving how
// long this day should be; the employee's own obligation is the only
// thing being satisfied here.
//
// Exported (2026-09-22, foreign-company roster top-up — see
// docs/known-limitations/roster-planning-vs-duty-allocation.md): the SAME
// "shortest legal catalog code" rule this stage already uses for the
// flexible pool is reused, unmodified, for foreign-company employees'
// non-flight-day top-up in specialized-team-generation.ts, rather than
// maintaining a second copy.
export function shortestFirstCatalogCodes(date: string): { code: string; entreeMin: number; sortieMin: number }[] {
  return Object.entries(shiftCatalogForDate(date))
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
 * MOST free days — that window is the best available "keep OFF" candidate.
 * Every free day OUTSIDE that window is returned first (in calendar order,
 * to top up), followed by the free days INSIDE the window (reserved, tried
 * only if still needed after every non-reserved free day has been
 * considered).
 *
 * Tie-break (2026-09-24, OFF/OFF milestone part A): among equally-good
 * windows, prefer `preferredStart` — the employee's PRE-STAGE-6 preferred
 * OFF window (lib/planning/off-window.ts's planPreferredOffWindows) — so
 * this final reservation pass reinforces, rather than fights, the window
 * Stage 6 was already steering toward; otherwise earliest start (the
 * original behaviour, unchanged when `preferredStart` is omitted). A
 * fully-free window always beats a partially-free preferred one: an
 * actually-achievable consecutive block matters more than which one. The
 * window search itself is the shared chooseBestCyclicWindowStart primitive
 * (off-window.ts), not a second copy.
 */
export function chooseTopUpReservedOffDays(
  daysOrder: string[],
  freeDays: ReadonlySet<string>,
  offDaysTarget: number,
  preferredStart?: number
): Set<string> {
  const freeDaysInOrder = daysOrder.filter((d) => freeDays.has(d));
  if (offDaysTarget <= 0 || freeDaysInOrder.length <= offDaysTarget) {
    // Nothing to reserve — either no OFF entitlement to preserve, or
    // there aren't even enough free days to exceed it, so every free day
    // is a genuine top-up candidate with no "reserved" set to protect.
    return new Set();
  }

  const bestStart = chooseBestCyclicWindowStart(
    daysOrder.length,
    offDaysTarget,
    (indices) => [indices.filter((i) => freeDays.has(daysOrder[i])).length],
    preferredStart
  );
  const reserved = new Set<string>();
  for (const day of cyclicWindowDays(daysOrder, bestStart, offDaysTarget)) {
    if (freeDays.has(day)) reserved.add(day);
  }
  return reserved;
}

/** Whether a shift's [entree,sortie] window (minute-of-day, sortie may wrap past midnight) contains the given minute-of-day — used only by the Stage-6 heuristic bias above, never by any legality check. */
function shiftWindowCoversMinute(entreeMin: number, sortieMin: number, minute: number): boolean {
  if (sortieMin > entreeMin) return minute >= entreeMin && minute < sortieMin;
  return minute >= entreeMin || minute < sortieMin; // overnight wrap
}

/**
 * SHARED PER-EMPLOYEE DAY-COUNT/HOURS TOP-UP CORE (factored out 2026-09-22
 * — see docs/known-limitations/roster-planning-vs-duty-allocation.md's
 * "foreign-company employees get a normal RAM weekly roster" fix). This is
 * the exact algorithm `generateObligationToppedUpShifts` already used for
 * the flexible General T1 pool (soft consecutive-OFF preference via
 * `chooseTopUpReservedOffDays`, forward rest lookahead against the next
 * already-fixed day, and the Sunday->Monday cyclic wrap safety check),
 * extracted so a SECOND caller (specialized-team-generation.ts's foreign-
 * company roster top-up) can reuse it byte-for-byte instead of maintaining
 * an independently-drifting copy of "prefer consecutive OFF days." Pure
 * per EMPLOYEE: the caller supplies that one employee's already-scheduled
 * days (from whatever source — demand-driven shifts for the flexible pool,
 * real company-flight-day shifts for a foreign-company employee) via
 * `getExistingShift`, and gets back only the ADDITIONAL days this stage
 * decided to add, as a day -> shiftCode map. Never mutates anything the
 * caller passed in.
 */
export function computeEmployeeDayCountTopUp(
  employeeId: string,
  daysOrder: string[],
  // The real Monday date this daysOrder window starts on — required so
  // every catalog lookup/shift-time resolution below (catalogCodesForDay,
  // legalCodesAt, the wrap safety check) uses the shift regime
  // actually effective on that SPECIFIC real calendar day, never one
  // global catalog for days that may straddle 2026-09-20.
  weekStart: string,
  initialScheduledDays: ReadonlySet<string>,
  initialScheduledHours: number,
  getExistingShift: (day: string) => { shiftCode: string } | undefined,
  priorWeekBoundaryContext: PriorDayShiftMap,
  minimumRestHours: number,
  targetWorkingDaysThisWindow: number,
  offDaysTarget: number,
  targetHoursThisWindow: number | null,
  // STAGE-6 HEURISTIC BIAS (2026-09-23, product owner's point 9) — OPTIONAL,
  // and a HEURISTIC BIAS ONLY, never an override of a hard labor-rule
  // constraint: this day's aggregate T1 demand peak instant (minute of day,
  // from zone-demand-aggregation.ts's peakAggregateT1DemandMinuteForDay,
  // computed on the flight schedule alone), or null/undefined when there is
  // no known peak (e.g. no flights that day, or the caller doesn't have one
  // — every existing caller/test that omits this keeps the exact prior
  // shortest-first behavior unchanged). When several catalog codes are all
  // EQUALLY LEGAL for a day (same rest-legality result), this breaks the
  // tie toward whichever legal code's shift window actually COVERS the
  // peak-demand instant, instead of always the shortest-first one. It never
  // discards a legal candidate and never makes an illegal one legal — see
  // `attemptDay` below for exactly where this applies.
  t1PeakDemandMinuteByDay?: Record<string, number | null>,
  // OFF/OFF MILESTONE PART A (2026-09-24) — OPTIONAL start index (into
  // daysOrder) of this employee's PRE-STAGE-6 preferred consecutive OFF
  // window (lib/planning/off-window.ts). Only a tie-break for which
  // equally-free consecutive block to reserve (see
  // chooseTopUpReservedOffDays); omitted = the original earliest-start
  // tie-break, byte-for-byte.
  preferredOffWindowStart?: number,
  // FATIGUE (2026-09-24, part 2) — see TopUpFatigueOptions. Optional;
  // omitted or disabled reproduces the prior ordering byte-for-byte.
  fatigue?: TopUpFatigueOptions,
  // HARD WORK CAPS (2026-09-25, phase 1) — see TopUpHardCaps. Applied inside
  // legalCodesAt, the SAME gate as the 15h rest check, so every code the
  // walk, the backtracking search, the neighbour-feasibility preference and
  // pass 2 ever see is already cap-legal. Omitted = no cap filtering.
  hardCaps?: TopUpHardCaps
): Map<string, string> {
  const additional = new Map<string, string>(); // day -> shiftCode, this employee only

  const scheduledDays = new Set<string>(initialScheduledDays);
  let shortfallHours = targetHoursThisWindow === null ? 0 : Math.max(0, targetHoursThisWindow - initialScheduledHours);
  const daysAlreadyMetTarget = scheduledDays.size >= targetWorkingDaysThisWindow;
  if (shortfallHours <= 0 && daysAlreadyMetTarget) return additional; // both objectives already satisfied by the input alone

  // Soft preference (Part 2): among this employee's currently-free days,
  // compute ONCE which ones are the best available consecutive-OFF block
  // to try to preserve — this set never changes as days get filled below.
  const freeDays = new Set(daysOrder.filter((d) => !scheduledDays.has(d)));
  const reservedOffDays = chooseTopUpReservedOffDays(daysOrder, freeDays, offDaysTarget, preferredOffWindowStart);

  // FORWARD lookahead against tomorrow's shift, exactly as
  // generateObligationToppedUpShifts always did — without this a top-up
  // shift added here could leave the following day's shift under-rested.
  //
  // 2026-09-24 (OFF/OFF milestone part A) — two strictly-safer extensions,
  // both of which only REMOVE candidates that were already doomed, never
  // add one:
  //  - tomorrow's shift may also be one THIS function added earlier (pass 2
  //    fills a reserved day whose neighbour pass 1 already topped up) —
  //    previously only an already-fixed shift was checked;
  //  - for a full 7-day window, the SAME-WEEK Sunday<->Monday wrap is
  //    checked here at selection time (Sunday looks ahead to Monday, Monday
  //    looks back to Sunday). Previously that wrap was only tested AFTER the
  //    walk (the CYCLIC WRAP SAFETY CHECK below), which then simply dropped
  //    the offending day — silently leaving the employee with 3 OFF days
  //    (below the 5-WORK target) and usually a separated pattern, even when
  //    a different, wrap-compatible code (e.g. AP01 instead of NR01 on a
  //    Monday after a Sunday AP01) was perfectly legal. The post-walk check
  //    stays as the backstop.
  const n = daysOrder.length;
  const wraps = n === 7;
  type Times = { shift_start: string; shift_end: string };
  function shiftOn(j: number, override?: { index: number; shift: Times }): Times | null {
    if (override && override.index === j) return override.shift;
    const d = daysOrder[j];
    const code = getExistingShift(d)?.shiftCode ?? additional.get(d);
    return code ? getShiftTimesAs(code, flightDateFor(weekStart, d)) : null;
  }
  // HARD WORK CAPS helpers (see TopUpHardCaps). The window's scheduled
  // hours are this function's own running value: initialScheduledHours
  // (the caller's already-scheduled days) plus every day added so far.
  function isWorkedAt(k: number, override?: { index: number; shift: Times }): boolean {
    if (override && override.index === k) return true;
    const d = daysOrder[k];
    return Boolean(getExistingShift(d)?.shiftCode ?? additional.get(d));
  }
  function scheduledHoursNow(override?: { index: number; shift: Times }): number {
    let hours = initialScheduledHours;
    for (const [d, code] of additional) hours += getShiftDurationHours(code, flightDateFor(weekStart, d));
    if (override && !isWorkedAt(override.index)) {
      const startMin = timeToMinutes(override.shift.shift_start);
      let endMin = timeToMinutes(override.shift.shift_end);
      if (endMin <= startMin) endMin += 24 * 60;
      hours += (endMin - startMin) / 60;
    }
    return hours;
  }
  /** Why day `j` is closed to every code by a hard cap, or null when the caps leave at least a code-level choice (hours filtering is then per code). */
  function capClosesDay(j: number, override?: { index: number; shift: Times }): HardCapExclusionReason | null {
    if (!hardCaps) return null;
    if (consecutiveRunLengthIfWorked((k) => isWorkedAt(k, override), j, n, hardCaps.incomingStreak) > hardCaps.caps.maxConsecutiveWorkDays) return "consecutive_work_days";
    return null;
  }
  /** Rest-legal catalog codes (shortest first) for day `j`, optionally pretending day `override.index` holds `override.shift`. With hardCaps (default), also cap-legal. */
  let capBound = false; // a hard cap has removed at least one rest-legal code during this employee's walk
  function legalCodesAt(j: number, override?: { index: number; shift: Times }, applyCaps = true): { code: string; entreeMin: number; sortieMin: number }[] {
    const restLegal = restLegalCodesAt(j, override);
    if (!hardCaps || !applyCaps || restLegal.length === 0) return restLegal;
    if (capClosesDay(j, override)) {
      capBound = true;
      return [];
    }
    const hoursNow = scheduledHoursNow(override);
    const date = flightDateFor(weekStart, daysOrder[j]);
    const capped = restLegal.filter((c) => !wouldExceedHardWeeklyHoursCap(hoursNow, getShiftDurationHours(c.code, date), hardCaps.caps.hardWeeklyHoursCap));
    if (capped.length < restLegal.length) capBound = true;
    return capped;
  }
  /** Whether the current window state keeps every OFF block within maxConsecutiveOffDays (always true when not supplied). */
  function offBlocksWithinRule(): boolean {
    const limit = hardCaps?.maxConsecutiveOffDays;
    if (limit === undefined) return true;
    return maxConsecutiveOffCyclic(daysOrder.map((_, k) => ({ status: isWorkedAt(k) ? ("working" as const) : ("off" as const) }))) <= limit;
  }
  function restLegalCodesAt(j: number, override?: { index: number; shift: Times }): { code: string; entreeMin: number; sortieMin: number }[] {
    const priorShifts: (Times | null)[] = [j === 0 ? priorWeekBoundaryContext.get(employeeId) ?? null : shiftOn(j - 1, override)];
    if (j === 0 && wraps) priorShifts.push(shiftOn(n - 1, override));
    const nextIndex = j + 1 < n ? j + 1 : wraps ? 0 : -1;
    const nextShift = nextIndex >= 0 && nextIndex !== j ? shiftOn(nextIndex, override) : null;
    // The catalog effective on THIS day's real date — resolved fresh per
    // day, never a single window-wide catalog, so a week straddling
    // 2026-09-20 picks the correct regime on each side of the boundary.
    return shortestFirstCatalogCodes(flightDateFor(weekStart, daysOrder[j])).filter((c) => {
      const entreeTime = minutesToTime(c.entreeMin);
      for (const priorShift of priorShifts) {
        if (priorShift && restHoursBetween(priorShift.shift_start, priorShift.shift_end, entreeTime) < minimumRestHours) return false;
      }
      if (nextShift && restHoursBetween(entreeTime, minutesToTime(c.sortieMin), nextShift.shift_start) < minimumRestHours) return false;
      return true;
    });
  }

  type CatalogCode = { code: string; entreeMin: number; sortieMin: number };

  // FATIGUE ORDERING (see TopUpFatigueOptions). Inert unless enabled.
  const fatigueActive = fatigue?.config.enabled === true;
  /** The employee's nearest worked shift strictly before day `i` (inside the window, else the prior-week boundary shift). */
  function lastWorkedBefore(i: number): LastWorkedShift | null {
    for (let j = i - 1; j >= 0; j--) {
      const code = getExistingShift(daysOrder[j])?.shiftCode ?? additional.get(daysOrder[j]);
      if (code) return { span: shiftSpanOnDate(code, flightDateFor(weekStart, daysOrder[j])), date: flightDateFor(weekStart, daysOrder[j]) };
    }
    const boundary = priorWeekBoundaryContext.get(employeeId);
    if (boundary) {
      const firstDate = flightDateFor(weekStart, daysOrder[0]);
      const d = new Date(`${firstDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return { span: spanFromResolvedTimes(boundary.shift_start, boundary.shift_end), date: d.toISOString().slice(0, 10) };
    }
    return null;
  }
  function projectCode(i: number, code: string): FatigueCandidateProjection {
    return projectFatigueForShift(employeeId, unknownFatigueState("Top-up code comparison (same employee, same base)."), lastWorkedBefore(i), code, flightDateFor(weekStart, daysOrder[i]), fatigue!.config);
  }
  /** Quantized burden of putting `code` on day `i`: own burden + transition in (projectCode) + transition out to the next worked day in the window. */
  function topUpBurdenSteps(i: number, code: string): number {
    const projection = projectCode(i, code);
    let burden = projection.after.accumulatedBurden;
    for (let k = i + 1; k < n; k++) {
      const nextCode = getExistingShift(daysOrder[k])?.shiftCode ?? additional.get(daysOrder[k]);
      if (!nextCode) continue;
      burden += transitionBurdenForSpans(shiftSpanOnDate(code, flightDateFor(weekStart, daysOrder[i])), shiftSpanOnDate(nextCode, flightDateFor(weekStart, daysOrder[k])), k - i, fatigue!.config);
      break;
    }
    return fatigueScoreSteps(burden);
  }
  /** Stable sort by fatigue steps ascending (original order breaks ties). */
  function byFatigue(i: number, list: CatalogCode[]): CatalogCode[] {
    return list
      .map((c, k) => ({ c, k, steps: topUpBurdenSteps(i, c.code) }))
      .sort((a, b) => a.steps - b.steps || a.k - b.k)
      .map((x) => x.c);
  }

  /**
   * Rest-legal codes for day `i`, in PREFERENCE order: the code the
   * original single-pick rule would choose comes first (neighbour-feasible,
   * then T1-peak-covering, then shortest), followed by the remaining
   * neighbour-feasible codes, then the remaining legal codes. Never
   * contains an illegal code.
   */
  function orderedCandidates(i: number, allowReserved: boolean, useFatigue: boolean = fatigueActive): CatalogCode[] {
    const day = daysOrder[i];
    const legalCandidates = legalCodesAt(i);
    if (legalCandidates.length === 0) return []; // no legally-rested shift available today — an honest gap

    // NEIGHBOUR-FEASIBILITY PREFERENCE (2026-09-24, OFF/OFF milestone
    // part A): among the already-legal codes, prefer one that still leaves
    // every free, not-reserved neighbouring day (previous/next, same-week
    // wrap for a 7-day window) with at least one legal code of its own.
    // Without this, the shortest-first pick could strand a neighbour — e.g.
    // a Monday MT03 (05:45) top-up after which the Sunday between a
    // Saturday MT02 and that Monday has no legal code left — so the walk
    // then had to fall back to a RESERVED day, splitting the OFF block.
    // Pure preference, never a legality change.
    const neighbourIndices = [i - 1 >= 0 ? i - 1 : wraps ? n - 1 : -1, i + 1 < n ? i + 1 : wraps ? 0 : -1].filter(
      (j) => j >= 0 && j !== i && freeDays.has(daysOrder[j]) && (allowReserved || !reservedOffDays.has(daysOrder[j]))
    );
    const neighbourSafe =
      neighbourIndices.length === 0
        ? legalCandidates
        : legalCandidates.filter((c) =>
            neighbourIndices.every(
              (j) => legalCodesAt(j, { index: i, shift: { shift_start: minutesToTime(c.entreeMin), shift_end: minutesToTime(c.sortieMin) } }).length > 0
            )
          );
    const preferredCandidates = neighbourSafe.length > 0 ? neighbourSafe : legalCandidates;

    // STAGE-6 HEURISTIC BIAS: among the already-legal candidates (rest
    // constraints already fully applied above — this NEVER widens or
    // overrides that set), prefer one whose window covers today's known T1
    // demand peak, breaking ties toward the original shortest-first catalog
    // order. `t1PeakDemandMinuteByDay` omitted/day missing/null -> exact
    // prior behavior (first catalog-order candidate).
    const peakMinute = t1PeakDemandMinuteByDay?.[day];
    if (useFatigue) {
      // Same structure as below, with each preference group re-ordered by
      // lower fatigue burden (stable — ties keep shortest-first order). The
      // T1-peak and neighbour-feasibility preferences still come first.
      const preferredByFatigue = byFatigue(i, preferredCandidates);
      const firstByFatigue =
        peakMinute != null && preferredByFatigue.length > 1
          ? preferredByFatigue.find((c) => shiftWindowCoversMinute(c.entreeMin, c.sortieMin, peakMinute)) ?? preferredByFatigue[0]
          : preferredByFatigue[0];
      return [
        firstByFatigue,
        ...preferredByFatigue.filter((c) => c !== firstByFatigue),
        ...byFatigue(i, legalCandidates.filter((c) => !preferredCandidates.includes(c))),
      ];
    }
    const first =
      peakMinute != null && preferredCandidates.length > 1
        ? preferredCandidates.find((c) => shiftWindowCoversMinute(c.entreeMin, c.sortieMin, peakMinute)) ?? preferredCandidates[0]
        : preferredCandidates[0];
    return [first, ...preferredCandidates.filter((c) => c !== first), ...legalCandidates.filter((c) => !preferredCandidates.includes(c))];
  }

  function commit(i: number, code: string): void {
    const day = daysOrder[i];
    additional.set(day, code);
    scheduledDays.add(day);
    freeDays.delete(day);
    shortfallHours -= getShiftDurationHours(code, flightDateFor(weekStart, day));
  }
  function uncommit(i: number, code: string): void {
    const day = daysOrder[i];
    additional.delete(day);
    scheduledDays.delete(day);
    freeDays.add(day);
    shortfallHours += getShiftDurationHours(code, flightDateFor(weekStart, day));
  }

  function attemptDay(i: number, allowReserved: boolean): boolean {
    const day = daysOrder[i];
    if (!freeDays.has(day)) return false; // already scheduled, or topped up earlier this walk
    if (scheduledDays.size >= targetWorkingDaysThisWindow) return false;
    if (reservedOffDays.has(day) && !allowReserved) return false; // leave OFF for now — preferred consecutive block
    const candidates = orderedCandidates(i, allowReserved);
    if (candidates.length === 0) return false; // leave the honest gap, try the next candidate day
    commit(i, candidates[0].code);
    return true;
  }

  // Pass 1: every free day NOT in the preferred reserved block.
  //
  // BOUNDED BACKTRACKING (2026-09-24, OFF/OFF milestone part A): a
  // depth-first search over those days, trying each day's codes in
  // orderedCandidates' preference order and "leave OFF" last. Its FIRST
  // leaf is exactly the original greedy walk (first preferred code each
  // day, skip a day with no legal code), so whenever the greedy walk
  // already reaches the day-count target the result is byte-for-byte
  // unchanged. It only explores further when the greedy walk would fall
  // short — the case that used to spill into the reserved OFF block in
  // pass 2 and split it (e.g. an early Monday code stranding Sunday via the
  // wrap). Capped at TOP_UP_SEARCH_NODE_BUDGET nodes; on exhaustion the
  // best (most days filled, first found) assignment seen is kept. Every
  // committed code is still individually rest-legal against its
  // neighbours — the search never relaxes a constraint.
  const pass1Days = daysOrder.map((d, i) => i).filter((i) => freeDays.has(daysOrder[i]) && !reservedOffDays.has(daysOrder[i]));
  const allFreeDaysAtStart = daysOrder.map((d, i) => i).filter((i) => freeDays.has(daysOrder[i]));
  let searchDays = pass1Days;
  let searchAllowsReserved = false;
  let nodeBudget = TOP_UP_SEARCH_NODE_BUDGET;
  let best: { size: number; commits: [number, string][]; offOk: boolean } | null = null;
  const trail: [number, string][] = [];
  // OFF-RULE-AWARE TARGET LEAF (2026-09-25, hard-constraints phase 2 part A):
  // with a cap-aware target BELOW the normal one (roster-target.ts), the
  // week has more OFF days than max_consecutive_off_days can hold in one
  // block, so the FIRST leaf reaching the target may put them all together
  // (e.g. Mon-Thu worked, Fri-Sun OFF). Only when TopUpHardCaps supplies
  // maxConsecutiveOffDays, such a leaf is kept as a fallback and the search
  // continues (same node budget) for a target-reaching leaf whose OFF blocks
  // respect the rule. With the normal target (<= 2 OFF days) every target
  // leaf already satisfies the rule, so this never changes that case.
  const offRuleActive = hardCaps?.maxConsecutiveOffDays !== undefined;
  const dfs = (k: number): boolean => {
    const reachedTarget = scheduledDays.size >= targetWorkingDaysThisWindow;
    if (reachedTarget || k === searchDays.length || nodeBudget <= 0) {
      const offOk = offBlocksWithinRule();
      // HARD-CAP TIE-BREAK (see TopUpHardCaps.maxConsecutiveOffDays): only
      // once a cap has bound (or a target leaf is being compared, above), an
      // equally-large assignment whose OFF blocks respect the consecutive-OFF
      // rule replaces one that does not.
      if (!best || scheduledDays.size > best.size || ((capBound || (offRuleActive && reachedTarget)) && scheduledDays.size === best.size && !best.offOk && offOk)) {
        best = { size: scheduledDays.size, commits: [...trail], offOk };
      }
      if (reachedTarget && offRuleActive && !offOk && nodeBudget > 0) return false; // keep looking for an OFF-rule-respecting target leaf
      return reachedTarget || nodeBudget <= 0;
    }
    const reachable = scheduledDays.size + (searchDays.length - k);
    const bestNeedsOffFix = best !== null && !best.offOk && (capBound || (offRuleActive && best.size >= targetWorkingDaysThisWindow));
    if (best && (reachable < best.size || (reachable === best.size && !bestNeedsOffFix))) return false; // cannot beat what we already have
    nodeBudget--;
    const i = searchDays[k];
    for (const c of orderedCandidates(i, searchAllowsReserved)) {
      commit(i, c.code);
      trail.push([i, c.code]);
      if (dfs(k + 1)) return true;
      trail.pop();
      uncommit(i, c.code);
    }
    return dfs(k + 1); // leave this day OFF
  };
  if (!dfs(0)) {
    // Search space exhausted without reaching the target — apply the best
    // partial assignment found (the state was fully unwound on the way out).
    const bestFound = best as { size: number; commits: [number, string][]; offOk: boolean } | null;
    for (const [i, code] of bestFound?.commits ?? []) commit(i, code);
  }
  // OFF-RULE SECOND SEARCH (phase 2 part A): the target was reached but only
  // with an over-long OFF block, because the non-reserved days alone could
  // not spread the (more than normal) OFF days — e.g. the only free days
  // outside the reserved pair are Thu-Sat, leaving Sun-Mon-Tue OFF. Search
  // once more over EVERY free day (reserved ones included, with a fresh
  // budget of the same size) for a target-reaching assignment that respects
  // max_consecutive_off_days; keep the first result if there is none. Never
  // runs with the normal target (<= 2 OFF days always satisfy the rule).
  if (offRuleActive && scheduledDays.size >= targetWorkingDaysThisWindow && !offBlocksWithinRule() && allFreeDaysAtStart.length > pass1Days.length) {
    const firstResult = [...additional.entries()];
    for (const [d, code] of firstResult) uncommit(daysOrder.indexOf(d), code);
    searchDays = allFreeDaysAtStart;
    searchAllowsReserved = true;
    nodeBudget = TOP_UP_SEARCH_NODE_BUDGET;
    best = null;
    trail.length = 0;
    const found = dfs(0) && offBlocksWithinRule();
    if (!found) {
      for (const [d, code] of [...additional.entries()]) uncommit(daysOrder.indexOf(d), code);
      for (const [d, code] of firstResult) commit(daysOrder.indexOf(d), code);
    }
  }
  shortfallHours = Math.max(0, shortfallHours);

  // Pass 2: if a real shortfall remains, fall back to the reserved days too.
  if (shortfallHours > 0 || scheduledDays.size < targetWorkingDaysThisWindow) {
    for (let i = 0; i < daysOrder.length; i++) {
      if (!freeDays.has(daysOrder[i])) continue;
      attemptDay(i, true);
      shortfallHours = Math.max(0, shortfallHours);
    }
  }

  // HARD-CAP SHORTFALL REPORTING: the day-count target is still unmet and a
  // free day that WAS rest-legal was closed off by a hard cap — recorded for
  // the caller's honest reporting (never filled).
  if (hardCaps?.shortfallOut && scheduledDays.size < targetWorkingDaysThisWindow) {
    for (let i = 0; i < n; i++) {
      if (!freeDays.has(daysOrder[i])) continue;
      if (legalCodesAt(i, undefined, false).length === 0 || legalCodesAt(i).length > 0) continue;
      hardCaps.shortfallOut.push({ day: daysOrder[i], reason: capClosesDay(i) ?? "hard_weekly_hours" });
    }
  }

  // CYCLIC WRAP SAFETY CHECK (Sunday -> following Monday) — see the
  // original doc comment on this same check (module history): a top-up
  // shift THIS function adds on either end of the window could still
  // create an illegal wraparound rest gap nothing else here tests. Fixed
  // by dropping whichever end THIS function added (never a real
  // already-scheduled day) rather than leaving it for a softer warning.
  if (daysOrder.length === 7) {
    const firstDay = daysOrder[0];
    const lastDay = daysOrder[daysOrder.length - 1];
    const firstCode = getExistingShift(firstDay)?.shiftCode ?? additional.get(firstDay);
    const lastCode = getExistingShift(lastDay)?.shiftCode ?? additional.get(lastDay);
    if (firstCode && lastCode) {
      const firstTimes = getShiftTimesAs(firstCode, flightDateFor(weekStart, firstDay));
      const lastTimes = getShiftTimesAs(lastCode, flightDateFor(weekStart, lastDay));
      const wrapRest = restHoursBetween(lastTimes.shift_start, lastTimes.shift_end, firstTimes.shift_start);
      if (wrapRest < minimumRestHours) {
        const lastIsTopUp = additional.has(lastDay) && !getExistingShift(lastDay);
        const firstIsTopUp = additional.has(firstDay) && !getExistingShift(firstDay);
        if (lastIsTopUp) additional.delete(lastDay);
        else if (firstIsTopUp) additional.delete(firstDay);
      }
    }
  }

  // FATIGUE EXPLAINABILITY: for each added day, the chosen code vs the
  // code the SAME ordering would have put first without the fatigue key
  // (re-evaluated against the final week). Same code -> fatigue did not
  // change the choice -> [].
  if (fatigueActive && fatigue!.reasonsOut) {
    for (const [day, code] of additional) {
      const i = daysOrder.indexOf(day);
      const displaced = orderedCandidates(i, reservedOffDays.has(day), false)[0];
      fatigue!.reasonsOut.set(
        day,
        displaced && displaced.code !== code ? explainFatigueChoice(projectCode(i, code), projectCode(i, displaced.code), fatigue!.config) : []
      );
    }
  }

  return additional;
}

/**
 * The shared context for one flexible-pool employee's top-up — everything
 * generateObligationToppedUpShifts reads besides the employee and Stage 6's
 * result. Factored out (2026-09-25, hard-constraints phase 2) so the
 * cross-employee repair pass (hard-cap-repair.ts) can SIMULATE an
 * employee's top-up on a candidate Stage-6 reallocation with the exact same
 * algorithm and arguments the real top-up then uses — never a second copy.
 */
export interface FlexibleTopUpContext {
  daysOrder: string[];
  config: Config;
  priorWeekBoundaryContext: PriorDayShiftMap;
  minimumRestHours: number;
  weekStart: string;
  t1PeakDemandMinuteByDay?: Record<string, number | null>;
  preferredOffDaysByEmployee?: ReadonlyMap<string, ReadonlySet<string>>;
  fatigueConfig?: FatigueConfig;
  hardCaps?: { caps: HardWorkCaps; incomingStreakByEmployee: ReadonlyMap<string, number> };
}

export interface FlexibleEmployeeTopUpResult {
  additions: Map<string, string>;
  fatigueReasons?: Map<string, string[]>;
  shortfall: { day: string; reason: HardCapExclusionReason }[];
  /** The cap-aware target this employee was topped up toward (null without hard caps: the fixed normal target applies). */
  target: CapAwareRosterTarget | null;
}

/**
 * One flexible-pool employee's Stage-6.5 top-up (see
 * generateObligationToppedUpShifts). PART A (2026-09-25, hard-constraints
 * phase 2): with hard caps, the day-count target is this employee's own
 * CAP-AWARE target (roster-target.ts's computeCapAwareTargetWorkDays, from
 * their real Stage-6 days and the real shortest code per free day) instead
 * of the fixed daysOrder.length - normal_weekly_off_days — so a week the
 * 42h cap genuinely limits to 4 days is topped up to 4 (normal) rather than
 * chasing an unreachable 5 and reporting a false shortfall. Without hard
 * caps the fixed target is used, byte-for-byte as before.
 */
export function computeFlexibleEmployeeTopUp(
  employeeId: string,
  demandDrivenShiftsByDay: Record<string, GeneratedShiftAssignment[]>,
  ctx: FlexibleTopUpContext
): FlexibleEmployeeTopUpResult {
  const { daysOrder, config, weekStart, hardCaps, fatigueConfig } = ctx;
  const normalTarget = Math.max(0, daysOrder.length - config.normal_weekly_off_days);
  const committedHoursByDay = new Map<string, number>();
  for (const day of daysOrder) {
    const g = (demandDrivenShiftsByDay[day] ?? []).find((x) => x.employeeId === employeeId);
    if (g) committedHoursByDay.set(day, getShiftDurationHours(g.shiftCode, flightDateFor(weekStart, day)));
  }
  const scheduledDays = new Set<string>(committedHoursByDay.keys());
  let scheduledHours = 0;
  for (const h of committedHoursByDay.values()) scheduledHours += h;
  const getExistingShift = (day: string) => (demandDrivenShiftsByDay[day] ?? []).find((x) => x.employeeId === employeeId);

  const target = hardCaps
    ? computeCapAwareTargetWorkDays({ daysOrder, weekStart, normalTargetWorkDays: normalTarget, hardWeeklyHoursCap: hardCaps.caps.hardWeeklyHoursCap, committedHoursByDay })
    : null;
  const targetWorkDays = target ? target.targetWorkDays : normalTarget;
  const offWindowLength = target
    ? preferredOffWindowLength(daysOrder.length, targetWorkDays, config.normal_weekly_off_days, config.max_consecutive_off_days)
    : config.normal_weekly_off_days;

  const fatigueReasons = fatigueConfig?.enabled ? new Map<string, string[]>() : undefined;
  const shortfall: { day: string; reason: HardCapExclusionReason }[] = [];
  const additions = computeEmployeeDayCountTopUp(
    employeeId,
    daysOrder,
    weekStart,
    scheduledDays,
    scheduledHours,
    getExistingShift,
    ctx.priorWeekBoundaryContext,
    ctx.minimumRestHours,
    targetWorkDays,
    offWindowLength,
    proratedObligationHoursForWindow(config, daysOrder.length),
    ctx.t1PeakDemandMinuteByDay,
    preferredWindowStart(daysOrder, ctx.preferredOffDaysByEmployee?.get(employeeId), offWindowLength),
    fatigueReasons ? { config: fatigueConfig!, reasonsOut: fatigueReasons } : undefined,
    hardCaps
      ? { caps: hardCaps.caps, incomingStreak: hardCaps.incomingStreakByEmployee.get(employeeId) ?? 0, shortfallOut: shortfall, maxConsecutiveOffDays: config.max_consecutive_off_days }
      : undefined
  );
  return { additions, fatigueReasons, shortfall, target };
}

/**
 * The continuous-roster-generation stage itself. Returns, per day, the
 * ADDITIONAL flexible-pool shift assignments needed to (1) reach the
 * employee's normal roster target — the confirmed "5 WORK + 2 OFF", or,
 * with hard caps, their own CAP-AWARE target (computeFlexibleEmployeeTopUp,
 * PART A) — ALWAYS (see this module's doc comment, objective 1), and (2)
 * once configured, move each employee toward their working-hours obligation
 * for this window (objective 2) — never a replacement for
 * `demandDrivenShiftsByDay`, which the caller must merge this output on top
 * of (a day already present in `demandDrivenShiftsByDay` for an employee is
 * left untouched here; this function only ever ADDS a day that demand alone
 * did not justify).
 */
export function generateObligationToppedUpShifts(
  daysOrder: string[],
  employees: Employee[],
  demandDrivenShiftsByDay: Record<string, GeneratedShiftAssignment[]>,
  config: Config,
  priorWeekBoundaryContext: PriorDayShiftMap,
  minimumRestHours: number,
  // The real Monday date this daysOrder window starts on — threaded down
  // to computeEmployeeDayCountTopUp so every catalog/shift-time lookup
  // resolves the regime effective on each real calendar day (see
  // lib/shift-templates.ts).
  weekStart: string,
  // STAGE-6 HEURISTIC BIAS (2026-09-23, product owner's point 9) — see
  // computeEmployeeDayCountTopUp's own doc comment on the parameter of the
  // same name. Optional; omitted (the default) reproduces the exact prior
  // shortest-first selection, so every existing caller/test keeps working
  // unchanged. generate-draft-plan.ts is the one real caller that computes
  // and passes this, from the flight schedule alone, before this stage runs.
  t1PeakDemandMinuteByDay?: Record<string, number | null>,
  // OFF/OFF MILESTONE PART A (2026-09-24) — each flexible ACE's pre-Stage-6
  // preferred OFF window (lib/planning/off-window.ts's
  // planPreferredOffWindows), the SAME map Stage 6 was biased with. Used
  // only as the reservation tie-break so both passes agree. Optional;
  // omitted reproduces the prior earliest-start behaviour exactly.
  preferredOffDaysByEmployee?: ReadonlyMap<string, ReadonlySet<string>>,
  // FATIGUE (2026-09-24, part 2) — see TopUpFatigueOptions. Optional;
  // omitted or `enabled: false` reproduces the prior output byte-for-byte
  // (no reordering, no fatigueReason key).
  fatigueConfig?: FatigueConfig,
  // HARD WORK CAPS (2026-09-25, phase 1) — see TopUpHardCaps. Each
  // employee's incoming consecutive-work-day streak (missing = 0; the caller
  // is responsible for disclosing unknown history). `exclusionsOut` receives
  // one record per day a cap kept an employee below the day-count target.
  // `targetsOut` (phase 2 part A) receives each employee's cap-aware target.
  // Omitted = no cap filtering and the fixed normal target.
  hardCaps?: { caps: HardWorkCaps; incomingStreakByEmployee: ReadonlyMap<string, number>; exclusionsOut?: HardCapExclusion[]; targetsOut?: Map<string, CapAwareRosterTarget> }
): Record<string, GeneratedShiftAssignment[]> {
  const additional: Record<string, GeneratedShiftAssignment[]> = {};
  for (const day of daysOrder) additional[day] = [];

  const ctx: FlexibleTopUpContext = {
    daysOrder,
    config,
    priorWeekBoundaryContext,
    minimumRestHours,
    weekStart,
    t1PeakDemandMinuteByDay,
    preferredOffDaysByEmployee,
    fatigueConfig,
    hardCaps: hardCaps ? { caps: hardCaps.caps, incomingStreakByEmployee: hardCaps.incomingStreakByEmployee } : undefined,
  };

  // Never schedule below the employee's OFF-day entitlement for this
  // displayed window, for EITHER objective — the same ceiling (the normal,
  // or cap-aware, target) governs both, so an hours top-up can never push
  // an employee past the roster shape objective 1 establishes.
  for (const employee of employees.filter(isFlexibleGeneralPool)) {
    const { additions, fatigueReasons, shortfall, target } = computeFlexibleEmployeeTopUp(employee.id, demandDrivenShiftsByDay, ctx);
    if (target) hardCaps?.targetsOut?.set(employee.id, target);
    for (const { day, reason } of shortfall) {
      hardCaps?.exclusionsOut?.push({ employeeId: employee.id, dayOfWeek: day, population: "flexible_pool_top_up", reason });
    }

    for (const [day, shiftCode] of additions) {
      const g: GeneratedShiftAssignment = { employeeId: employee.id, dayOfWeek: day, shiftCode, coversRoles: [] };
      if (fatigueReasons) g.fatigueReason = fatigueReasons.get(day) ?? [];
      additional[day].push(g);
    }
  }

  return additional;
}
