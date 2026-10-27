import { Employee, Config, Flight, StaffingRequirement } from "../types";
import { GeneratedShiftAssignment, PriorDayShiftMap } from "./shift-generation";
import { isFlexibleGeneralPool } from "./workforce-pools";
import { isEligibleForDefaultCheckinPlacement } from "./checkin-zone-placement";
import { getRequirementWindow, RAM_OPERATION_ROLES } from "./requirement-window";
import { getShiftTimesAs, getShiftDurationHours, shiftCatalogForDate } from "../shift-templates";
import { restHoursBetween } from "../roster-generation";
import { flightDateFor } from "../flight-date";
import { chooseBestCyclicWindowStart, cyclicWindowDays, preferredWindowStart } from "./off-window";
import { FatigueConfig } from "../fatigue-config";
import { unknownFatigueState, transitionBurdenForSpans, spanFromResolvedTimes } from "./fatigue-model";
import { projectFatigueForShift, explainFatigueChoice, shiftSpanOnDate, LastWorkedShift, FatigueCandidateProjection } from "./fatigue-planning";
import { fatigueScoreSteps } from "./stage6-score-tiers";
import { maxConsecutiveOffCyclic } from "./consecutive-off";
import { HardWorkCaps, HardCapExclusion, HardCapExclusionReason, consecutiveRunLengthIfWorked } from "./hard-work-caps";

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
 * T1 CHECK-IN TOP-UP COVERAGE BIAS (2026-10-27) — a SECOND, zone-and-window
 * -aware T1 preference, layered alongside (never replacing) the single
 * aggregate-peak-minute bias above. One `T1ZoneWindowGap` is one zone's one
 * demand window (the exact shape zoneRequirementsByDay/checkin-capacity-
 * timeline.ts already use) still short of its required headcount once
 * Stage 6 + hard-cap repair's own real, demand-driven shifts are accounted
 * for — see buildRemainingT1ZoneGaps below for how the starting `remaining`
 * values are computed, and generate-draft-plan.ts for where that baseline
 * is built, BEFORE this stage runs.
 *
 * `remaining` is intentionally mutable and SHARED BY REFERENCE across every
 * employee this generation pass tops up (see generateObligationToppedUpShifts):
 * each employee's chosen top-up code decrements the windows it fully covers,
 * so the NEXT employee's search sees the updated picture instead of every
 * candidate independently chasing the same single biggest gap. This is a
 * greedy, order-dependent allocation — the same documented trade-off
 * checkin-capacity-timeline.ts's own per-instant greedy split already
 * accepts (see that module's "HONEST LIMITATION" paragraph): it never
 * double-books a window below zero and never claims more credit than a
 * window's real remaining headcount, but it cannot jointly optimize across
 * every employee and every window at once.
 *
 * FULL-WINDOW COVERAGE ONLY (never partial): see windowFullyCovered below —
 * a shift must contain a zone window's ENTIRE [windowStart, windowEnd] to
 * earn any credit toward it. A zone window that itself wraps past midnight
 * (windowEnd minutes <= windowStart minutes) can never be credited here —
 * no top-up code is ever overnight (shortestFirstCatalogCodes filters those
 * out entirely), so crediting it would always be dishonest; it is simply
 * left out of scoring; the real, authoritative Required/Available/Gap
 * report for every window (including overnight ones) remains entirely
 * checkin-capacity-timeline.ts's job, computed later from the REAL final
 * roster and real specific-duty intervals — this bias never claims
 * coverage itself, it only steers which already-legal catalog code the
 * top-up picks.
 */
export interface T1ZoneWindowGap {
  zone: string;
  windowStart: string;
  windowEnd: string;
  /** Still-needed headcount for this window, net of everyone already committed before this pass and everyone this pass has committed so far. Mutated in place — see this interface's own doc comment. */
  remaining: number;
}

/**
 * Per-employee, per-generation-pass T1 coverage context (see
 * T1ZoneWindowGap's doc comment). Entirely optional and additive: omitted
 * (the default for every existing caller/test) reproduces
 * computeEmployeeDayCountTopUp's prior candidate ordering byte-for-byte —
 * the T1-peak-minute bias above is the only T1 signal that applies then,
 * exactly as before.
 */
export interface TopUpT1CoverageOptions {
  /** Per-day remaining T1 Check-in zone/window gaps — see T1ZoneWindowGap. Shared by reference and mutated across this whole generation pass. */
  remainingByDay: Record<string, T1ZoneWindowGap[]>;
  /** Whether THIS employee is Check-in eligible at all (checkin-zone-placement.ts's isEligibleForDefaultCheckinPlacement). An ineligible employee never gets this preference and never touches the shared state — avoids crediting (or double-crediting) an employee who could never actually be placed on T1 Check-in. */
  employeeEligible: boolean;
}

/** Whether [entreeMin, sortieMin) (a non-overnight top-up shift) fully contains a zone window's entire [windowStart, windowEnd) — partial overlap is never credited (see T1ZoneWindowGap's doc comment). */
function windowFullyCovered(entreeMin: number, sortieMin: number, windowStart: string, windowEnd: string): boolean {
  const wStart = timeToMinutes(windowStart);
  const wEnd = timeToMinutes(windowEnd);
  if (wEnd <= wStart) return false; // cross-midnight zone window — no top-up code (always non-overnight) can ever honestly cover this
  return entreeMin <= wStart && sortieMin >= wEnd;
}

/**
 * Builds the STARTING `remaining` values for one day's T1ZoneWindowGap list
 * — the real zone demand (`zoneRequirements`, computed from the flight
 * schedule alone, entirely independent of the roster) minus whoever is
 * ALREADY committed to a shift that day that fully covers a given window,
 * among `committedShifts` (Stage 6 + hard-cap-repair's real, demand-driven
 * result for the flexible pool — the only other shifts decided before this
 * stage runs).
 *
 * HONEST, DOCUMENTED LIMITATION (consistent with this stage's own position
 * in the pipeline — see roster-generation.ts's module doc comment and
 * generate-draft-plan.ts's execution order): this counts an eligible,
 * already-shifted employee as covering a window they OVERLAP, without
 * knowing whether Stage 9 (duty-generation.ts, which runs LATER) will
 * actually place them on Gate/Boarding/Profiling duty instead that day —
 * that per-flight allocation genuinely does not exist yet at this point in
 * the pipeline. It intentionally does NOT exclude employees who may end up
 * on Gate/Boarding duty (impossible to know yet), only employees who can
 * never be placed on T1 Check-in at all regardless of the day (Profiling/
 * Mesure-assigned, non-redeployable foreign-company, no Check-in skill,
 * etc. — isEligibleForDefaultCheckinPlacement, the SAME real eligibility
 * rule checkin-capacity-timeline.ts itself uses). This can under-count real
 * remaining demand in a tight week; it can never OVER-claim it (never
 * credits more than `required_headcount`, never goes negative) — a
 * conservative-toward-over-rostering, never conservative-toward-leaving-a-
 * gap-unaddressed bias, appropriate for a tie-break that only ever ADDS
 * weight toward covering T1, never removes a legal candidate or claims
 * actual coverage (see T1ZoneWindowGap's own doc comment — the real,
 * authoritative Required/Available/Gap report stays entirely
 * checkin-capacity-timeline.ts's job, computed later from Stage 9's real
 * result).
 */
export function buildRemainingT1ZoneGaps(
  weekStart: string,
  day: string,
  zoneRequirements: { zone: string; window_start: string; window_end: string; required_headcount: number }[],
  committedShifts: GeneratedShiftAssignment[],
  employees: readonly Employee[]
): T1ZoneWindowGap[] {
  if (zoneRequirements.length === 0) return [];
  const eligibleIds = new Set(employees.filter(isEligibleForDefaultCheckinPlacement).map((e) => e.id));
  const date = flightDateFor(weekStart, day);
  const committedWindows: { entreeMin: number; sortieMin: number }[] = [];
  for (const g of committedShifts) {
    if (!eligibleIds.has(g.employeeId)) continue;
    const times = getShiftTimesAs(g.shiftCode, date);
    const entreeMin = timeToMinutes(times.shift_start);
    const sortieMinRaw = timeToMinutes(times.shift_end);
    const sortieMin = sortieMinRaw > entreeMin ? sortieMinRaw : sortieMinRaw + 24 * 60; // normalize a real overnight committed shift (e.g. a prior-day carryover) so containment comparisons below stay correct; top-up codes themselves are never overnight
    committedWindows.push({ entreeMin, sortieMin });
  }
  return zoneRequirements.map((req) => {
    const covering = committedWindows.filter((w) => windowFullyCovered(w.entreeMin, w.sortieMin, req.window_start, req.window_end)).length;
    return { zone: req.zone, windowStart: req.window_start, windowEnd: req.window_end, remaining: Math.max(0, req.required_headcount - covering) };
  });
}

/**
 * RAM DUTY (Gate/Boarding/Profiling/Mesure) TOP-UP COVERAGE BIAS (2026-10-27)
 * — the SAME mechanism as T1ZoneWindowGap/buildRemainingT1ZoneGaps above,
 * generalized from T1 Check-in zone demand to real flight-duty requirement
 * windows (getRequirementWindow's T-60/T-90-minute-before-departure rule for
 * RAM_OPERATION_ROLES — see requirement-window.ts). This exists because the
 * exact same enabling fact holds here as it did for T1: the window is
 * computable from the flight schedule ALONE, with zero roster dependency,
 * so it is known before this top-up stage runs, just like T1 zone demand.
 *
 * Built directly in response to a traced, concrete planning gap (AT512's
 * 06:15 Gate/Boarding window going unstaffed while a rest-unconstrained,
 * OFF-the-day-before flexible employee was instead given an idle default
 * shift) — this bias steers that same idle employee's top-up code toward
 * ALSO covering a real, still-short duty window when they hold the matching
 * skill, exactly how the T1 bias already steers toward T1 Check-in gaps.
 *
 * One `DutyWindowGap` is one flight+role's own requirement window (unlike
 * T1's per-zone aggregation, these are NOT merged across flights — two
 * flights needing Gate the same morning are two separate windows, each with
 * its own `remaining`, since they are genuinely separate operational
 * obligations that can require different people). `role` is a plain RAM
 * operation-rule role name ("Gate", "Boarding", "Profiling", "Mesure");
 * eligibility to close a given gap is per-role (an employee's
 * `skills` must include that exact role), unlike T1's single boolean
 * eligibility flag — see TopUpDutyCoverageOptions below.
 */
export interface DutyWindowGap {
  role: string;
  windowStart: string;
  windowEnd: string;
  /** Still-needed headcount for this specific flight+role window, net of everyone already committed before this pass and everyone this pass has committed so far. Mutated in place — see this interface's own doc comment. */
  remaining: number;
}

/**
 * Per-employee, per-generation-pass duty coverage context — the duty
 * analogue of TopUpT1CoverageOptions. Entirely optional and additive:
 * omitted (the default for every existing caller/test) leaves
 * computeEmployeeDayCountTopUp's candidate ordering completely unaffected
 * by this bias; the T1 bias and the existing peak-minute bias are unchanged
 * either way.
 */
export interface TopUpDutyCoverageOptions {
  /** Per-day remaining duty windows — see DutyWindowGap. Shared by reference and mutated across this whole generation pass. */
  remainingByDay: Record<string, DutyWindowGap[]>;
  /** This employee's own skills, intersected with RAM_OPERATION_ROLES — e.g. an employee with skills ["Boarding", "Check-in"] can only ever close a "Boarding" gap, never a "Gate" or "Profiling" one. Empty set = this bias never applies to this employee (never touches the shared state), exactly like T1's `employeeEligible: false`. */
  employeeRoles: ReadonlySet<string>;
}

/**
 * Builds the STARTING `remaining` values for one day's DutyWindowGap list —
 * the real per-flight, per-role requirement (`requirements`, computed from
 * the flight schedule alone via computeWeeklyStaffingRequirements, entirely
 * independent of the roster) minus whoever is ALREADY committed to a shift
 * that day that fully covers a given requirement's window AND holds the
 * matching skill, among `committedShifts` (Stage 6 + hard-cap-repair's real,
 * demand-driven result for the flexible pool — the only other shifts
 * decided before this stage runs; the SAME input buildRemainingT1ZoneGaps
 * already uses).
 *
 * Only `fixed_rule` RAM_OPERATION_ROLES requirements with real headcount are
 * considered — this naturally excludes `missingOperationRuleRequirement`'s
 * placeholder rows (role "Staffing Rule"/"Destination Classification",
 * total_requirement 0) and every self-managed `company_config` requirement,
 * neither of which this bias has any business touching.
 *
 * HONEST, DOCUMENTED LIMITATION (the exact same one buildRemainingT1ZoneGaps
 * already discloses, inherited unchanged): this counts an eligible,
 * already-shifted employee as covering a window they overlap, without
 * knowing whether Stage 9 (duty-generation.ts, which runs LATER) will
 * actually place them on THIS specific flight's duty rather than another
 * one, or redeploy them elsewhere entirely — that per-flight allocation
 * genuinely does not exist yet at this point in the pipeline. This can
 * under-count real remaining demand in a tight week; it can never
 * OVER-claim it (never credits more than a requirement's own
 * `total_requirement`, never goes negative) — a tie-break that only ever
 * ADDS weight toward closing a real duty gap, never removes a legal
 * candidate or claims actual coverage itself. The real, authoritative
 * Gate/Boarding/Profiling/Mesure coverage report stays entirely Stage 9's
 * job, computed later from the real final roster and real duty allocation.
 */
export function buildRemainingDutyGaps(
  weekStart: string,
  day: string,
  requirements: readonly StaffingRequirement[],
  flights: readonly Flight[],
  committedShifts: GeneratedShiftAssignment[],
  employees: readonly Employee[]
): DutyWindowGap[] {
  const flightsById = new Map(flights.map((f) => [f.id, f]));
  const dayRequirements = requirements.filter((r) => {
    if (r.source !== "fixed_rule" || !RAM_OPERATION_ROLES.has(r.role) || r.total_requirement <= 0) return false;
    const flight = flightsById.get(r.flight_id);
    return flight != null && flight.day_of_week === day;
  });
  if (dayRequirements.length === 0) return [];

  const date = flightDateFor(weekStart, day);
  // Cached per role (not per requirement) — several requirements the same
  // day often share a role, and an employee's committed shift window for
  // that day never changes across them.
  const committedWindowsByRole = new Map<string, { entreeMin: number; sortieMin: number }[]>();
  function committedWindowsForRole(role: string): { entreeMin: number; sortieMin: number }[] {
    const cached = committedWindowsByRole.get(role);
    if (cached) return cached;
    const eligibleIds = new Set(employees.filter((e) => e.skills.includes(role)).map((e) => e.id));
    const windows: { entreeMin: number; sortieMin: number }[] = [];
    for (const g of committedShifts) {
      if (!eligibleIds.has(g.employeeId)) continue;
      const times = getShiftTimesAs(g.shiftCode, date);
      const entreeMin = timeToMinutes(times.shift_start);
      const sortieMinRaw = timeToMinutes(times.shift_end);
      const sortieMin = sortieMinRaw > entreeMin ? sortieMinRaw : sortieMinRaw + 24 * 60; // normalize a real overnight committed shift so containment comparisons stay correct; top-up codes themselves are never overnight
      windows.push({ entreeMin, sortieMin });
    }
    committedWindowsByRole.set(role, windows);
    return windows;
  }

  return dayRequirements.map((r) => {
    const flight = flightsById.get(r.flight_id)!;
    const window = getRequirementWindow(r, flight);
    const windows = committedWindowsForRole(r.role);
    const covering = windows.filter((w) => windowFullyCovered(w.entreeMin, w.sortieMin, window.start, window.end)).length;
    return { role: r.role, windowStart: window.start, windowEnd: window.end, remaining: Math.max(0, r.total_requirement - covering) };
  });
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
  hardCaps?: TopUpHardCaps,
  // T1 CHECK-IN ZONE/WINDOW COVERAGE BIAS (2026-10-27) — see
  // TopUpT1CoverageOptions. A SECOND, zone-and-window-aware T1 preference,
  // applied at the exact same tier as the existing single-peak-minute bias
  // above (see orderedCandidates — it takes priority when it has a real
  // positive-score candidate, falling back to the peak-minute bias
  // otherwise). Omitted, or `employeeEligible: false` — reproduces the
  // prior ordering byte-for-byte; every existing caller/test keeps working
  // unchanged.
  t1Coverage?: TopUpT1CoverageOptions,
  /** Output: day -> explanation, for each day this call's FINAL chosen code was picked because it plugged a real T1 Check-in gap (vs. the code the ordering would have preferred without this bias) — mirrors `fatigue.reasonsOut`'s own convention. Only ever set when `t1Coverage` is supplied and eligible. */
  t1CoverageReasonsOut?: Map<string, string>,
  /**
   * Output: day -> exactly the T1ZoneWindowGap entries THIS call's final,
   * kept commit for that day decremented (empty/absent day = nothing
   * decremented). Lets a caller that later decides to DROP one of this
   * call's additions (computeFlexibleEmployeeTopUp's own
   * normal_off_days_consecutive guard is the one real case) reverse
   * EXACTLY the right credit, by the SAME precise-reversal rule
   * t1UndoCommit itself uses internally — recomputing "what would this
   * code cover now" after the fact would be wrong (see this function's own
   * t1UndoCommit doc comment). Only ever populated when `t1Coverage` is
   * supplied and the employee is eligible; omitted = not populated, no
   * behavior change for any caller that doesn't ask for it.
   */
  t1DecrementedByDayOut?: Map<string, T1ZoneWindowGap[]>,
  // RAM DUTY (Gate/Boarding/Profiling/Mesure) COVERAGE BIAS (2026-10-27) —
  // see TopUpDutyCoverageOptions. A THIRD preference, combined ADDITIVELY
  // with the T1 zone/window score (see orderedCandidates/pickFirst — the
  // two scores are summed, so a code closing both a T1 gap and a duty gap
  // outranks one closing only either alone) at the exact same tier, ahead
  // of the single-peak-minute bias. Omitted, or an employee with no
  // matching skills (`employeeRoles` empty) — reproduces the prior ordering
  // byte-for-byte; every existing caller/test keeps working unchanged.
  dutyCoverage?: TopUpDutyCoverageOptions,
  /** Output: day -> explanation, mirrors t1CoverageReasonsOut's own convention, for the duty-coverage bias. Only ever set when `dutyCoverage` is supplied and the employee has at least one matching role. */
  dutyCoverageReasonsOut?: Map<string, string>,
  /** Output: day -> exactly the DutyWindowGap entries THIS call's final, kept commit for that day decremented — mirrors t1DecrementedByDayOut's own convention/purpose exactly. */
  dutyDecrementedByDayOut?: Map<string, DutyWindowGap[]>,
  // BASELINE SHIFT CODE TIE-BREAK (2026-10-27 — see this module's own
  // doc comment on shortestFirstCatalogCodes). On a day with no real
  // demand signal at all (no T1/duty coverage, no peak-minute match —
  // orderedCandidates' pickFirst would otherwise fall through to
  // `list[0]`), several catalog codes are routinely tied for the
  // shortest legal duration (e.g. MT03/NR01/AP01 all at 9h00 in the
  // current regime). `list[0]` among ties is decided purely by
  // Object.entries(shiftCatalogForDate(...))'s OWN insertion order —
  // an accident of the catalog's declaration order, never a real
  // decision — which is how an entire idle week silently converged on
  // one single code (MT03) for nearly every employee regardless of
  // team or personal pattern, while employees for whom that code
  // happened to be rest-illegal fell through to whichever code was
  // next in that same accidental order. This parameter is the
  // employee's own STATIC `shift_code` (Employee.shift_code — their
  // regular, contracted pattern, never the day's generated code):
  // when it is itself among the legal candidates tied for the
  // shortest duration, it is preferred over the catalog's own
  // insertion-order default. Never picks a LONGER shift than the
  // shortest-legal rule already requires, never overrides a real
  // coverage/peak-minute signal (both are checked first), and is a
  // no-op whenever the employee's baseline code isn't itself tied for
  // shortest that day. Omitted/null — reproduces the prior
  // (catalog-order) behavior exactly, so every existing caller/test
  // keeps working unchanged.
  employeeBaselineShiftCode?: string | null
): Map<string, string> {
  const additional = new Map<string, string>(); // day -> shiftCode, this employee only
  const t1Active = t1Coverage?.employeeEligible === true;
  // Which T1ZoneWindowGap entries THIS call's currently-open commit (per
  // day) actually decremented — recorded at commit time so uncommit can
  // reverse EXACTLY those, never a value recomputed after the decrement
  // (see T1ZoneWindowGap's own doc comment on why that would be unsafe).
  // At most one open commit per day at a time (the DFS below is strictly
  // LIFO per day index), so a plain Map keyed by day is sufficient.
  const t1DecrementedByDay = new Map<string, T1ZoneWindowGap[]>();
  function t1CodeTimes(day: string, code: string): { entreeMin: number; sortieMin: number } {
    const times = getShiftTimesAs(code, flightDateFor(weekStart, day));
    return { entreeMin: timeToMinutes(times.shift_start), sortieMin: timeToMinutes(times.shift_end) };
  }
  /** Read-only: total still-needed headcount across every T1 window `code` would fully cover on `day`, among windows that still have real remaining demand. Never mutates. */
  function t1CoverageScore(day: string, code: string): number {
    if (!t1Active) return 0;
    const windows = t1Coverage!.remainingByDay[day];
    if (!windows || windows.length === 0) return 0;
    const { entreeMin, sortieMin } = t1CodeTimes(day, code);
    let score = 0;
    for (const w of windows) if (w.remaining > 0 && windowFullyCovered(entreeMin, sortieMin, w.windowStart, w.windowEnd)) score += w.remaining;
    return score;
  }
  /** Decrements (by 1, floor 0) every T1 window `code` fully covers on `day`, recording exactly which ones so a matching t1UndoCommit can reverse it precisely. */
  function t1ApplyCommit(day: string, code: string): void {
    if (!t1Active) return;
    const windows = t1Coverage!.remainingByDay[day];
    if (!windows || windows.length === 0) return;
    const { entreeMin, sortieMin } = t1CodeTimes(day, code);
    const decremented: T1ZoneWindowGap[] = [];
    for (const w of windows) {
      if (w.remaining > 0 && windowFullyCovered(entreeMin, sortieMin, w.windowStart, w.windowEnd)) {
        w.remaining -= 1;
        decremented.push(w);
      }
    }
    if (decremented.length > 0) t1DecrementedByDay.set(day, decremented);
    else t1DecrementedByDay.delete(day);
  }
  /** Reverses exactly what the matching t1ApplyCommit(day, ...) decremented — never a recomputation (see T1ZoneWindowGap's doc comment). */
  function t1UndoCommit(day: string): void {
    if (!t1Active) return;
    const decremented = t1DecrementedByDay.get(day);
    if (!decremented) return;
    for (const w of decremented) w.remaining += 1;
    t1DecrementedByDay.delete(day);
  }

  // RAM DUTY COVERAGE BIAS (2026-10-27) — exact structural mirror of the T1
  // score/commit/undo trio above, see TopUpDutyCoverageOptions/DutyWindowGap.
  const dutyActive = Boolean(dutyCoverage && dutyCoverage.employeeRoles.size > 0);
  const dutyDecrementedByDay = new Map<string, DutyWindowGap[]>();
  /** Read-only: total still-needed headcount across every duty window `code` would fully cover on `day`, among windows for a role THIS employee actually holds and that still have real remaining demand. Never mutates. */
  function dutyCoverageScore(day: string, code: string): number {
    if (!dutyActive) return 0;
    const windows = dutyCoverage!.remainingByDay[day];
    if (!windows || windows.length === 0) return 0;
    const { entreeMin, sortieMin } = t1CodeTimes(day, code);
    let score = 0;
    for (const w of windows) {
      if (w.remaining > 0 && dutyCoverage!.employeeRoles.has(w.role) && windowFullyCovered(entreeMin, sortieMin, w.windowStart, w.windowEnd)) score += w.remaining;
    }
    return score;
  }
  /** Decrements (by 1, floor 0) every duty window `code` fully covers (for a role this employee holds) on `day`, recording exactly which ones so a matching dutyUndoCommit can reverse it precisely. */
  function dutyApplyCommit(day: string, code: string): void {
    if (!dutyActive) return;
    const windows = dutyCoverage!.remainingByDay[day];
    if (!windows || windows.length === 0) return;
    const { entreeMin, sortieMin } = t1CodeTimes(day, code);
    const decremented: DutyWindowGap[] = [];
    for (const w of windows) {
      if (w.remaining > 0 && dutyCoverage!.employeeRoles.has(w.role) && windowFullyCovered(entreeMin, sortieMin, w.windowStart, w.windowEnd)) {
        w.remaining -= 1;
        decremented.push(w);
      }
    }
    if (decremented.length > 0) dutyDecrementedByDay.set(day, decremented);
    else dutyDecrementedByDay.delete(day);
  }
  /** Reverses exactly what the matching dutyApplyCommit(day, ...) decremented — never a recomputation (see T1ZoneWindowGap's doc comment, same rationale). */
  function dutyUndoCommit(day: string): void {
    if (!dutyActive) return;
    const decremented = dutyDecrementedByDay.get(day);
    if (!decremented) return;
    for (const w of decremented) w.remaining += 1;
    dutyDecrementedByDay.delete(day);
  }

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
  // HARD WORK CAPS helpers (see TopUpHardCaps) — the consecutive-work-day
  // cap only (2026-09-29: an hours-based cap used to live here too; see
  // legalCodesAt's removal note).
  function isWorkedAt(k: number, override?: { index: number; shift: Times }): boolean {
    if (override && override.index === k) return true;
    const d = daysOrder[k];
    return Boolean(getExistingShift(d)?.shiftCode ?? additional.get(d));
  }
  /** Why day `j` is closed to every code by a hard cap (the consecutive-work-day cap only — see legalCodesAt's 2026-09-29 removal note). */
  function capClosesDay(j: number, override?: { index: number; shift: Times }): HardCapExclusionReason | null {
    if (!hardCaps) return null;
    if (consecutiveRunLengthIfWorked((k) => isWorkedAt(k, override), j, n, hardCaps.incomingStreak) > hardCaps.caps.maxConsecutiveWorkDays) return "consecutive_work_days";
    return null;
  }
  /** Rest-legal catalog codes (shortest first) for day `j`, optionally pretending day `override.index` holds `override.shift`. With hardCaps (default), also cap-legal. */
  let capBound = false; // the hard consecutive-work-day cap has closed at least one day during this employee's walk
  function legalCodesAt(j: number, override?: { index: number; shift: Times }, applyCaps = true): { code: string; entreeMin: number; sortieMin: number }[] {
    const restLegal = restLegalCodesAt(j, override);
    if (!hardCaps || !applyCaps || restLegal.length === 0) return restLegal;
    if (capClosesDay(j, override)) {
      capBound = true;
      return [];
    }
    // 2026-09-29: an hours-based per-code filter used to run here too
    // (dropping a code that would push this week's scheduled hours past a
    // per-week ceiling) — removed, not relabeled; see hard-work-caps.ts's
    // removal note. Every rest-legal, day-open code is now cap-legal.
    return restLegal;
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
    /**
     * Picks the preferred candidate from `list` (already fatigue-ordered
     * when fatigue is active, else in preferredCandidates/shortest-first
     * order). T1 ZONE/WINDOW COVERAGE (2026-10-27) takes priority when it
     * finds a real (score > 0) gap-covering candidate — among ties on that
     * score, prefer one that ALSO covers the aggregate peak-demand minute,
     * else keep the first (list-order) top scorer. Falls back to the
     * EXISTING single-peak-minute search untouched whenever t1Active is
     * false or no candidate scores above 0 — byte-identical to the prior
     * behavior in that case.
     */
    function combinedCoverageScore(code: string): number {
      return t1CoverageScore(day, code) + dutyCoverageScore(day, code);
    }
    function pickFirst(list: CatalogCode[]): CatalogCode {
      if ((t1Active || dutyActive) && list.length > 1) {
        let bestScore = -1;
        for (const c of list) {
          const s = combinedCoverageScore(c.code);
          if (s > bestScore) bestScore = s;
        }
        if (bestScore > 0) {
          const topScorers = list.filter((c) => combinedCoverageScore(c.code) === bestScore);
          const peakAndTopScore = peakMinute != null ? topScorers.find((c) => shiftWindowCoversMinute(c.entreeMin, c.sortieMin, peakMinute)) : undefined;
          return peakAndTopScore ?? topScorers[0];
        }
      }
      if (peakMinute != null && list.length > 1) {
        const peakMatch = list.find((c) => shiftWindowCoversMinute(c.entreeMin, c.sortieMin, peakMinute));
        if (peakMatch) return peakMatch;
      }
      // No real coverage or peak-minute signal at all — see this
      // function's `employeeBaselineShiftCode` param doc comment: prefer
      // the employee's own baseline code over list[0]'s accidental
      // catalog-order default, but ONLY when it's genuinely tied with
      // list[0] for the shortest legal duration (never a longer shift
      // than the rule already requires).
      if (employeeBaselineShiftCode && list.length > 1) {
        const shortestDuration = list[0].sortieMin - list[0].entreeMin;
        const baselineMatch = list.find((c) => c.code === employeeBaselineShiftCode && c.sortieMin - c.entreeMin === shortestDuration);
        if (baselineMatch) return baselineMatch;
      }
      return list[0];
    }
    if (useFatigue) {
      // Same structure as below, with each preference group re-ordered by
      // lower fatigue burden (stable — ties keep shortest-first order). The
      // T1 (zone/window, then peak-minute) and neighbour-feasibility
      // preferences still come first.
      const preferredByFatigue = byFatigue(i, preferredCandidates);
      const firstByFatigue = pickFirst(preferredByFatigue);
      return [
        firstByFatigue,
        ...preferredByFatigue.filter((c) => c !== firstByFatigue),
        ...byFatigue(i, legalCandidates.filter((c) => !preferredCandidates.includes(c))),
      ];
    }
    const first = pickFirst(preferredCandidates);
    return [first, ...preferredCandidates.filter((c) => c !== first), ...legalCandidates.filter((c) => !preferredCandidates.includes(c))];
  }

  function commit(i: number, code: string): void {
    const day = daysOrder[i];
    additional.set(day, code);
    scheduledDays.add(day);
    freeDays.delete(day);
    shortfallHours -= getShiftDurationHours(code, flightDateFor(weekStart, day));
    t1ApplyCommit(day, code);
    dutyApplyCommit(day, code);
  }
  function uncommit(i: number, code: string): void {
    const day = daysOrder[i];
    additional.delete(day);
    scheduledDays.delete(day);
    freeDays.add(day);
    shortfallHours += getShiftDurationHours(code, flightDateFor(weekStart, day));
    t1UndoCommit(day);
    dutyUndoCommit(day);
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
  // free day that WAS rest-legal was closed off by the hard consecutive-
  // work-day cap — recorded for the caller's honest reporting (never
  // filled). (2026-09-29: an hours-cap-driven closure used to be possible
  // here too — with that removed, capClosesDay is now the only way
  // legalCodesAt can go from non-empty-without-caps to empty-with-caps.)
  if (hardCaps?.shortfallOut && scheduledDays.size < targetWorkingDaysThisWindow) {
    for (let i = 0; i < n; i++) {
      if (!freeDays.has(daysOrder[i])) continue;
      if (legalCodesAt(i, undefined, false).length === 0 || legalCodesAt(i).length > 0) continue;
      const reason = capClosesDay(i);
      if (reason) hardCaps.shortfallOut.push({ day: daysOrder[i], reason });
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
        // This bypasses commit/uncommit's own bookkeeping (scheduledDays/
        // freeDays/shortfallHours go stale here too, same as before this
        // change — nothing below re-reads them), so the T1 decrement this
        // dropped day applied must be undone here too, or the shared
        // remaining-gap state would stay wrongly decremented for every
        // later employee this generation pass still has to process.
        if (lastIsTopUp) {
          additional.delete(lastDay);
          t1UndoCommit(lastDay);
          dutyUndoCommit(lastDay);
        } else if (firstIsTopUp) {
          additional.delete(firstDay);
          t1UndoCommit(firstDay);
          dutyUndoCommit(firstDay);
        }
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

  // T1 COVERAGE EXPLAINABILITY (2026-10-27): for each FINAL added day whose
  // chosen code still fully covers a real (post-decrement) T1 gap, a plain-
  // words note — never a raw score, same convention as fatigue above.
  // Re-checks against the CURRENT (already-decremented-by-this-employee's-
  // own-other-days) state, so the note reflects what this code actually
  // still closes in the final result, not a stale pre-walk snapshot.
  if (t1Active && t1CoverageReasonsOut) {
    for (const day of additional.keys()) {
      // t1DecrementedByDay already holds exactly the windows THIS day's
      // live, final commit decremented (see t1ApplyCommit/t1UndoCommit) —
      // no need to recompute coverage here.
      const justClosed = t1DecrementedByDay.get(day);
      if (justClosed && justClosed.length > 0) {
        const parts = justClosed.map((w) => `${w.zone} (${w.windowStart}–${w.windowEnd})`);
        t1CoverageReasonsOut.set(day, `Covers T1 Check-in demand still short on ${parts.join(", ")}, in addition to the normal roster obligation.`);
      }
    }
  }
  if (t1Active && t1DecrementedByDayOut) {
    for (const [day, windows] of t1DecrementedByDay) t1DecrementedByDayOut.set(day, windows);
  }

  // RAM DUTY COVERAGE EXPLAINABILITY (2026-10-27) — exact mirror of the T1
  // explainability block above.
  if (dutyActive && dutyCoverageReasonsOut) {
    for (const day of additional.keys()) {
      const justClosed = dutyDecrementedByDay.get(day);
      if (justClosed && justClosed.length > 0) {
        const parts = justClosed.map((w) => `${w.role} (${w.windowStart}–${w.windowEnd})`);
        dutyCoverageReasonsOut.set(day, `Covers a flight duty requirement still short on ${parts.join(", ")}, in addition to the normal roster obligation.`);
      }
    }
  }
  if (dutyActive && dutyDecrementedByDayOut) {
    for (const [day, windows] of dutyDecrementedByDay) dutyDecrementedByDayOut.set(day, windows);
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
  // T1 CHECK-IN ZONE/WINDOW COVERAGE BIAS (2026-10-27) — see
  // TopUpT1CoverageOptions. Deliberately OMITTED from the FlexibleTopUpContext
  // hard-cap-repair.ts builds for its own simulateTopUp callback (see
  // generate-draft-plan.ts) — that simulation runs BEFORE the real top-up and
  // must never permanently decrement the SAME shared remaining-gap state the
  // real top-up relies on later. generate-draft-plan.ts is the one real
  // caller that supplies this, for the real (not simulated) top-up only.
  remainingT1ZoneGapsByDay?: Record<string, T1ZoneWindowGap[]>;
  // RAM DUTY COVERAGE BIAS (2026-10-27) — see TopUpDutyCoverageOptions. Same
  // "deliberately omitted from hard-cap-repair.ts's simulation context"
  // rationale as remainingT1ZoneGapsByDay above — generate-draft-plan.ts is
  // the one real caller that supplies this, for the real (not simulated)
  // top-up only.
  remainingDutyGapsByDay?: Record<string, DutyWindowGap[]>;
}

export interface FlexibleEmployeeTopUpResult {
  additions: Map<string, string>;
  fatigueReasons?: Map<string, string[]>;
  shortfall: { day: string; reason: HardCapExclusionReason }[];
  /** day -> plain-words T1 coverage explanation — see computeEmployeeDayCountTopUp's t1CoverageReasonsOut. Only present when this employee is T1-eligible and ctx.remainingT1ZoneGapsByDay was supplied. */
  t1CoverageReasons?: Map<string, string>;
  /** day -> plain-words duty coverage explanation — see computeEmployeeDayCountTopUp's dutyCoverageReasonsOut. Only present when this employee has at least one matching role and ctx.remainingDutyGapsByDay was supplied. */
  dutyCoverageReasons?: Map<string, string>;
}

/**
 * One flexible-pool employee's Stage-6.5 top-up (see
 * generateObligationToppedUpShifts). The day-count target is always the
 * confirmed normal one (daysOrder.length - normal_weekly_off_days).
 * (2026-09-25 through 2026-09-28, PART A of the hard-constraints phase 2
 * milestone computed an HOURS-based "cap-aware" target here instead,
 * reducing it below normal whenever an employee's real shift codes would
 * sum past a per-week hours ceiling — REMOVED 2026-09-29: that ceiling was
 * never a confirmed rule; see hard-work-caps.ts's removal note. The normal
 * target applies unconditionally now, hard caps or not.)
 *
 * 2026-10-27 FIX (off_days_not_consecutive parity with the Profiling/
 * Mesure/foreign-company top-up): computeEmployeeDayCountTopUp's own
 * "Pass 2: if a real shortfall remains, fall back to the reserved days
 * too" (roster-generation.ts) can add a day INSIDE the employee's reserved
 * consecutive-OFF block to close a genuine shortfall — that's correct and
 * intentional on its own, but it SPLITS what was otherwise a single legal
 * OFF block into two separated short ones (each individually still under
 * max_consecutive_off_days, so nothing inside that search catches it) —
 * exactly the off_days_not_consecutive shape validation.ts's
 * checkOffDaysSeparated treats as a HARD violation whenever
 * config.normal_off_days_consecutive is true. specialized-team-
 * generation.ts's structurally-identical Profiling/Mesure/foreign-company
 * top-up already guards against this by dropping any addition that lands
 * inside its own reserved block (see its "Two guards" doc comment); this
 * function never had the equivalent guard, so every genuine shortfall
 * among FLEXIBLE pool ("General T1 Pool") employees — not just hard-cap-
 * excluded ones — could silently fragment their OFF block instead of
 * surfacing an honest, human-reviewable gap. Recomputing the SAME reserved
 * block here (chooseTopUpReservedOffDays, the exact pure function
 * computeEmployeeDayCountTopUp already used internally, with the exact
 * same inputs) and dropping any addition inside it reproduces that same
 * honest-gap convention here. No-op when the rule is off or nothing was
 * added inside the block — every existing test keeps passing unchanged.
 */
export function computeFlexibleEmployeeTopUp(
  employeeId: string,
  demandDrivenShiftsByDay: Record<string, GeneratedShiftAssignment[]>,
  ctx: FlexibleTopUpContext,
  // T1 CHECK-IN ZONE/WINDOW COVERAGE BIAS (2026-10-27) — whether THIS
  // employee is Check-in eligible at all (see TopUpT1CoverageOptions).
  // Irrelevant (and never consulted) when ctx.remainingT1ZoneGapsByDay is
  // omitted. The caller (generateObligationToppedUpShifts) computes this
  // once per employee via isEligibleForDefaultCheckinPlacement; omitted
  // here = treated as ineligible = no change from before this feature.
  employeeT1Eligible = false,
  // RAM DUTY COVERAGE BIAS (2026-10-27) — this employee's own skills
  // intersected with RAM_OPERATION_ROLES (see TopUpDutyCoverageOptions).
  // Irrelevant (and never consulted) when ctx.remainingDutyGapsByDay is
  // omitted. The caller (generateObligationToppedUpShifts) computes this
  // once per employee; omitted here = empty set = no change from before
  // this feature.
  employeeDutyRoles: ReadonlySet<string> = new Set(),
  // BASELINE SHIFT CODE TIE-BREAK (2026-10-27) — see
  // computeEmployeeDayCountTopUp's own `employeeBaselineShiftCode` doc
  // comment. Threaded straight through; omitted = prior catalog-order
  // behavior, unchanged.
  employeeBaselineShiftCode?: string | null
): FlexibleEmployeeTopUpResult {
  const { daysOrder, config, weekStart, hardCaps, fatigueConfig } = ctx;
  const targetWorkDays = Math.max(0, daysOrder.length - config.normal_weekly_off_days);
  const offWindowLength = config.normal_weekly_off_days;
  const committedHoursByDay = new Map<string, number>();
  for (const day of daysOrder) {
    const g = (demandDrivenShiftsByDay[day] ?? []).find((x) => x.employeeId === employeeId);
    if (g) committedHoursByDay.set(day, getShiftDurationHours(g.shiftCode, flightDateFor(weekStart, day)));
  }
  const scheduledDays = new Set<string>(committedHoursByDay.keys());
  let scheduledHours = 0;
  for (const h of committedHoursByDay.values()) scheduledHours += h;
  const getExistingShift = (day: string) => (demandDrivenShiftsByDay[day] ?? []).find((x) => x.employeeId === employeeId);

  const fatigueReasons = fatigueConfig?.enabled ? new Map<string, string[]>() : undefined;
  const shortfall: { day: string; reason: HardCapExclusionReason }[] = [];
  const preferredStart = preferredWindowStart(daysOrder, ctx.preferredOffDaysByEmployee?.get(employeeId), offWindowLength);
  const t1Active = Boolean(ctx.remainingT1ZoneGapsByDay) && employeeT1Eligible;
  const t1CoverageReasons = t1Active ? new Map<string, string>() : undefined;
  const t1Decremented = t1Active ? new Map<string, T1ZoneWindowGap[]>() : undefined;
  const dutyActive = Boolean(ctx.remainingDutyGapsByDay) && employeeDutyRoles.size > 0;
  const dutyCoverageReasons = dutyActive ? new Map<string, string>() : undefined;
  const dutyDecremented = dutyActive ? new Map<string, DutyWindowGap[]>() : undefined;
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
    preferredStart,
    fatigueReasons ? { config: fatigueConfig!, reasonsOut: fatigueReasons } : undefined,
    hardCaps
      ? { caps: hardCaps.caps, incomingStreak: hardCaps.incomingStreakByEmployee.get(employeeId) ?? 0, shortfallOut: shortfall, maxConsecutiveOffDays: config.max_consecutive_off_days }
      : undefined,
    t1Active ? { remainingByDay: ctx.remainingT1ZoneGapsByDay!, employeeEligible: true } : undefined,
    t1CoverageReasons,
    t1Decremented,
    dutyActive ? { remainingByDay: ctx.remainingDutyGapsByDay!, employeeRoles: employeeDutyRoles } : undefined,
    dutyCoverageReasons,
    dutyDecremented,
    employeeBaselineShiftCode
  );

  let finalAdditions = additions;
  if (config.normal_off_days_consecutive) {
    const freeDays = new Set(daysOrder.filter((d) => !scheduledDays.has(d)));
    const reserved = chooseTopUpReservedOffDays(daysOrder, freeDays, offWindowLength, preferredStart);
    if (reserved.size > 0) {
      const dropped = [...additions].filter(([day]) => reserved.has(day));
      const kept = new Map([...additions].filter(([day]) => !reserved.has(day)));
      // SAFETY (x2): dropping the reserved-window addition can only ever ADD
      // an OFF day (never remove one), so it must earn its place by actually
      // curing the split, not just moving it:
      //  (a) the extra OFF day can land next to an already-OFF day from an
      //      unrelated cause (a demand-driven gap, or another hard-cap-
      //      closed day elsewhere this week) and form a run LONGER than
      //      config.max_consecutive_off_days — a different hard violation
      //      (consecutive_off_violation) the split never was;
      //  (b) in a heavily cap-constrained week (several OTHER days already
      //      forced OFF by max_consecutive_work_days), the week's OFF days
      //      can already be unavoidably scattered for reasons that have
      //      nothing to do with this one reserved-window addition — dropping
      //      it then only loses a day of real coverage while the split
      //      persists regardless.
      // So the drop is adopted only when the resulting pattern is a genuine,
      // full cure: within the cap AND every OFF day in that one cyclic run.
      // Otherwise the addition stays (the pre-fix split, still the
      // lesser-evil fallback for a case this one narrow move cannot fix).
      if (kept.size !== additions.size) {
        const workedAt = (adds: Map<string, string>, day: string) => scheduledDays.has(day) || adds.has(day);
        const runFor = (adds: Map<string, string>) =>
          maxConsecutiveOffCyclic(daysOrder.map((day) => ({ status: workedAt(adds, day) ? ("working" as const) : ("off" as const) })));
        const offCountFor = (adds: Map<string, string>) => daysOrder.filter((day) => !workedAt(adds, day)).length;
        const keptRun = runFor(kept);
        const keptOffCount = offCountFor(kept);
        const isOneCleanBlock = keptRun <= config.max_consecutive_off_days && (keptOffCount === 0 || keptRun === keptOffCount);
        if (isOneCleanBlock) {
          finalAdditions = kept;
          // T1 CORRECTNESS (2026-10-27): a dropped day's T1 credit was
          // already applied (permanently, inside the computeEmployeeDayCountTopUp
          // call above) to the SHARED remainingByDay state — reverse exactly
          // what that day decremented (t1Decremented, never a recomputation;
          // see T1ZoneWindowGap's own doc comment) so later employees in this
          // same pass see the correct, un-double-counted picture.
          if (t1Active && t1Decremented) {
            for (const [day] of dropped) {
              for (const w of t1Decremented.get(day) ?? []) w.remaining += 1;
              t1CoverageReasons?.delete(day);
            }
          }
          // RAM DUTY CORRECTNESS (2026-10-27) — same reversal, for the duty
          // coverage bias's own shared state; see the T1 comment above.
          if (dutyActive && dutyDecremented) {
            for (const [day] of dropped) {
              for (const w of dutyDecremented.get(day) ?? []) w.remaining += 1;
              dutyCoverageReasons?.delete(day);
            }
          }
        }
      }
    }
  }

  return { additions: finalAdditions, fatigueReasons, shortfall, t1CoverageReasons, dutyCoverageReasons };
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
  // Omitted = no cap filtering.
  hardCaps?: { caps: HardWorkCaps; incomingStreakByEmployee: ReadonlyMap<string, number>; exclusionsOut?: HardCapExclusion[] },
  // T1 CHECK-IN ZONE/WINDOW COVERAGE BIAS (2026-10-27) — see
  // TopUpT1CoverageOptions and buildRemainingT1ZoneGaps. Per-day remaining
  // T1 Check-in zone/window gaps, already net of Stage 6 + hard-cap
  // repair's real demand-driven result (generate-draft-plan.ts builds this
  // right before calling this function). Mutated in place as each eligible
  // employee processed below is topped up — see T1ZoneWindowGap's own doc
  // comment. Optional; omitted reproduces the prior output byte-for-byte —
  // every existing caller/test keeps working unchanged.
  remainingT1ZoneGapsByDay?: Record<string, T1ZoneWindowGap[]>,
  // RAM DUTY (Gate/Boarding/Profiling/Mesure) COVERAGE BIAS (2026-10-27) —
  // see TopUpDutyCoverageOptions and buildRemainingDutyGaps. Per-day
  // remaining duty-requirement windows, already net of Stage 6 + hard-cap
  // repair's real demand-driven result (generate-draft-plan.ts builds this
  // right before calling this function, the same way it already builds
  // remainingT1ZoneGapsByDay). Mutated in place as each matching-skill
  // employee processed below is topped up. Optional; omitted reproduces the
  // prior output byte-for-byte — every existing caller/test keeps working
  // unchanged.
  remainingDutyGapsByDay?: Record<string, DutyWindowGap[]>
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
    remainingT1ZoneGapsByDay,
    remainingDutyGapsByDay,
  };

  // Never schedule below the employee's OFF-day entitlement for this
  // displayed window, for EITHER objective — the same ceiling (the normal,
  // or cap-aware, target) governs both, so an hours top-up can never push
  // an employee past the roster shape objective 1 establishes.
  for (const employee of employees.filter(isFlexibleGeneralPool)) {
    const employeeT1Eligible = Boolean(remainingT1ZoneGapsByDay) && isEligibleForDefaultCheckinPlacement(employee);
    const employeeDutyRoles: ReadonlySet<string> = remainingDutyGapsByDay
      ? new Set(employee.skills.filter((s) => RAM_OPERATION_ROLES.has(s)))
      : new Set();
    const { additions, fatigueReasons, shortfall, t1CoverageReasons, dutyCoverageReasons } = computeFlexibleEmployeeTopUp(
      employee.id,
      demandDrivenShiftsByDay,
      ctx,
      employeeT1Eligible,
      employeeDutyRoles,
      employee.shift_code
    );
    for (const { day, reason } of shortfall) {
      hardCaps?.exclusionsOut?.push({ employeeId: employee.id, dayOfWeek: day, population: "flexible_pool_top_up", reason });
    }

    for (const [day, shiftCode] of additions) {
      const g: GeneratedShiftAssignment = { employeeId: employee.id, dayOfWeek: day, shiftCode, coversRoles: [] };
      if (fatigueReasons) g.fatigueReason = fatigueReasons.get(day) ?? [];
      const t1Reason = t1CoverageReasons?.get(day);
      if (t1Reason) g.t1CoverageReason = t1Reason;
      const dutyReason = dutyCoverageReasons?.get(day);
      if (dutyReason) g.dutyCoverageReason = dutyReason;
      additional[day].push(g);
    }
  }

  return additional;
}
