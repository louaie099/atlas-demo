import { Employee } from "../types";
import { DailyDemand } from "./demand-aggregation";
import { isFlexibleGeneralPool } from "./workforce-pools";
import { shiftCatalogForDate } from "../shift-templates";
import { flightDateFor } from "../flight-date";
import { restHoursBetween } from "../roster-generation";

/**
 * CONSECUTIVE OFF/OFF WINDOW PLANNING (2026-09-24, fatigue-aware roster
 * planning milestone, part 1 — "Part A").
 *
 * ROOT CAUSE THIS MODULE EXISTS FOR: a flexible ACE's OFF days used to be a
 * pure side effect. Stage 6 (shift-generation.ts's
 * generateFlexiblePoolShifts) assigned shifts bucket by bucket with no idea
 * which days should form someone's weekly OFF/OFF block, and Stage 6.5's
 * top-up (roster-generation.ts's computeEmployeeDayCountTopUp) could only
 * choose a consecutive block among whatever days Stage 6 happened to leave
 * free — it cannot un-scatter a pattern Stage 6 already produced.
 *
 * This module adds the missing concept — a per-employee PREFERRED OFF
 * WINDOW for the week, decided BEFORE Stage 6 runs — and the one shared
 * cyclic sliding-window primitive that both passes now use:
 *
 *   - planPreferredOffWindows (pre-Stage-6): picks each flexible ACE's
 *     preferred consecutive OFF window from predicted demand. Stage 6 then
 *     gets a small, strictly-bounded structural penalty for rostering
 *     someone on a day inside their own window (stage6-score-tiers.ts,
 *     tier 3) — coverage always wins, rest legality is never touched.
 *   - chooseBestCyclicWindowStart (shared): the wraparound-aware
 *     window search (Sat–Sun, Sun–Mon wrap, ...) formerly inlined in
 *     roster-generation.ts's chooseTopUpReservedOffDays, extracted so the
 *     pre-Stage-6 planner and the Stage-6.5 top-up use ONE algorithm, not
 *     two drifting copies. The top-up now also takes the pre-planned window
 *     as its tie-break, so the two passes reinforce each other: when the
 *     pre-planned window is still fully free after Stage 6, the top-up
 *     keeps exactly that window OFF.
 *
 * Everything here is a SOFT preference. A separated-OFF result stays fully
 * legal (validation.ts's non-blocking `separated_off_days` PlanIssue still
 * fires exactly when it happens), and nothing here ever widens or narrows
 * the set of legal candidates or creates a coverage gap.
 */

/**
 * Picks the start index of the best cyclic (wraparound-aware) window of
 * `windowLength` consecutive positions out of `n`, where a window's
 * quality is `windowKey(dayIndicesInWindow)` compared LEXICOGRAPHICALLY
 * (higher is better, element by element). Ties are broken toward
 * `preferredStart` when it is among the tied best windows, otherwise
 * toward the earliest start — fully deterministic.
 *
 * The wraparound convention matches lib/planning/consecutive-off.ts's
 * maxConsecutiveOffCyclic: the last position's neighbour is position 0,
 * so e.g. {Sunday, Monday} of the same displayed week is a candidate
 * window (the weekly pattern is assumed to repeat).
 */
export function chooseBestCyclicWindowStart(
  n: number,
  windowLength: number,
  windowKey: (dayIndices: number[]) => number[],
  preferredStart?: number,
  isAllowedStart: (start: number) => boolean = () => true
): number {
  let bestStart = -1;
  let bestKey: number[] | null = null;
  const compare = (a: number[], b: number[]): number => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  for (let start = 0; start < n; start++) {
    if (!isAllowedStart(start)) continue;
    const indices = Array.from({ length: windowLength }, (_, k) => (start + k) % n);
    const key = windowKey(indices);
    if (bestKey === null) {
      bestKey = key;
      bestStart = start;
      continue;
    }
    const c = compare(key, bestKey);
    if (c > 0 || (c === 0 && start === preferredStart)) {
      bestKey = key;
      bestStart = start;
    }
  }
  return bestStart;
}

/** The day labels of the cyclic window of `windowLength` days starting at `start`. */
export function cyclicWindowDays(daysOrder: string[], start: number, windowLength: number): string[] {
  return Array.from({ length: windowLength }, (_, k) => daysOrder[(start + k) % daysOrder.length]);
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Median duration (minutes) of the non-overnight catalog codes effective on
 * `date` — resolved through shiftCatalogForDate, never SHIFT_CODES, so the
 * estimate tracks the real regime (pre/post 2026-09-20). Used only to turn
 * "person-buckets of demand" into "roughly how many people".
 */
function medianShiftMinutesForDate(date: string): number {
  const durations = Object.values(shiftCatalogForDate(date))
    .map(({ entree, sortie }) => timeToMinutes(sortie) - timeToMinutes(entree))
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return 8 * 60;
  return durations[Math.floor(durations.length / 2)];
}

/**
 * COARSE, PRE-STAGE-6 estimate of how many flexible ACEs a day needs —
 * the larger of (a) the day's peak simultaneous demand and (b) total
 * person-time of demand divided by the median real shift length for that
 * date. Hard per-role demand (`roles`) and the aggregate T1 Check-in
 * profile are both counted. Deliberately ignores qualifications and exact
 * shift fit: this only steers WHERE OFF days are preferred, never who is
 * legal or needed — Stage 6 still makes every real coverage decision.
 */
export function estimateDailyRequiredHeadcount(
  demand: DailyDemand | undefined,
  t1DemandByBucket: number[] | undefined,
  date: string,
  roles: string[]
): number {
  const bucketCount = Math.max(demand?.buckets.length ?? 0, t1DemandByBucket?.length ?? 0);
  if (bucketCount === 0) return 0;
  const bucketMinutes = (24 * 60) / bucketCount;
  let peak = 0;
  let personBuckets = 0;
  for (let i = 0; i < bucketCount; i++) {
    let v = Math.max(0, t1DemandByBucket?.[i] ?? 0);
    const byRole = demand?.buckets[i]?.demandByRole ?? {};
    for (const role of roles) v += Math.max(0, byRole[role] ?? 0);
    peak = Math.max(peak, v);
    personBuckets += v;
  }
  const bucketsPerShift = Math.max(1, medianShiftMinutesForDate(date) / bucketMinutes);
  return Math.max(peak, Math.ceil(personBuckets / bucketsPerShift));
}

export interface PlanPreferredOffWindowsInput {
  daysOrder: string[];
  weekStart: string;
  employees: Employee[];
  demandByDay: Record<string, DailyDemand>;
  t1DemandByBucketByDay?: Record<string, number[]>;
  offDaysTarget: number;
  /** Stage-6 hard roles counted by the demand estimate (the same list Stage 6 scores). */
  roles: string[];
  /**
   * Flexible ACEs KNOWN (from a real persisted predecessor plan — never the
   * static fallback, see rotation-context.ts's BoundaryContextProvenance)
   * to have been OFF on the calendar day immediately before daysOrder[0].
   * A window containing daysOrder[0] would then extend that real OFF run
   * across the week boundary (e.g. prior Sat–Sun OFF + this Mon–Tue OFF =
   * 4 consecutive), so such windows are skipped for these employees.
   * Omitted / empty = no cross-week information, no restriction.
   */
  priorDayOffEmployeeIds?: ReadonlySet<string>;
}

/**
 * PRE-STAGE-6 PREFERRED OFF WINDOW HEURISTIC (engineering judgment call,
 * documented as such — a prototype heuristic, not a confirmed RAM rule):
 *
 * "Demand-aware water-filling." Before Stage 6 knows who will work which
 * day, the only thing known about the week is its predicted demand. So:
 *
 *   1. For every day, estimate required flexible headcount
 *      (estimateDailyRequiredHeadcount) and start each day with
 *      `offCapacity[d] = flexiblePoolSize - required[d]` — how many people
 *      could be OFF that day without that day running short.
 *   2. Walk flexible ACEs in a fixed order (employee id ascending) and give
 *      each one the cyclic window of `offDaysTarget` consecutive days whose
 *      REMAINING offCapacity is best — highest minimum over the window's
 *      days first, then highest sum — then subtract 1 from each day of that
 *      window. Ties go to the earliest start.
 *   3. Windows that would extend a KNOWN real prior-day OFF run across the
 *      week boundary are skipped for that employee (see
 *      priorDayOffEmployeeIds).
 *
 * Why this shape: it places OFF blocks on the lowest-demand days first,
 * and SPREADS them (each assignment lowers that window's attractiveness
 * for the next person), so no single day is emptied — which is exactly
 * what lets Stage 6 cover each day with people whose window it is NOT,
 * rather than scattering everybody's OFF days. Different demand shapes
 * genuinely produce different placements (a light Wednesday attracts OFF
 * blocks; a heavy one repels them); the previous implicit behaviour put
 * every fully-idle employee's OFF block on Monday–Tuesday regardless of
 * demand, purely from an earliest-start tie-break.
 *
 * Deterministic: same inputs → same output (fixed employee order, fixed
 * tie-break, no randomness, no clock). It also tends to be STABLE week to
 * week for a similar demand shape (same employee order, same slack
 * profile → same window), which is what keeps real cross-week OFF runs
 * short; where it is not stable, step 3 guards the one boundary we have
 * real data for.
 *
 * Returns an empty map (no preference for anyone — Stage 6 and the top-up
 * then behave exactly as before) when there is no OFF entitlement to
 * place or the window is too short to hold one.
 */
export function planPreferredOffWindows(input: PlanPreferredOffWindowsInput): Map<string, ReadonlySet<string>> {
  const { daysOrder, weekStart, employees, demandByDay, t1DemandByBucketByDay, offDaysTarget, roles } = input;
  const result = new Map<string, ReadonlySet<string>>();
  const n = daysOrder.length;
  if (offDaysTarget <= 0 || n <= offDaysTarget) return result;

  const flexible = employees.filter(isFlexibleGeneralPool).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (flexible.length === 0) return result;

  const offCapacity = daysOrder.map(
    (day) =>
      flexible.length -
      estimateDailyRequiredHeadcount(demandByDay[day], t1DemandByBucketByDay?.[day], flightDateFor(weekStart, day), roles)
  );

  const windowKey = (indices: number[]) => [Math.min(...indices.map((i) => offCapacity[i])), indices.reduce((s, i) => s + offCapacity[i], 0)];

  for (const employee of flexible) {
    const avoidFirstDay = input.priorDayOffEmployeeIds?.has(employee.id) ?? false;
    const allowed = (start: number) => {
      if (!avoidFirstDay) return true;
      for (let k = 0; k < offDaysTarget; k++) if ((start + k) % n === 0) return false;
      return true;
    };
    let start = chooseBestCyclicWindowStart(n, offDaysTarget, windowKey, undefined, allowed);
    if (start < 0) start = chooseBestCyclicWindowStart(n, offDaysTarget, windowKey); // every window excluded — never leave someone without a preference
    for (let k = 0; k < offDaysTarget; k++) offCapacity[(start + k) % n]--;
    result.set(employee.id, new Set(cyclicWindowDays(daysOrder, start, offDaysTarget)));
  }
  return result;
}

/**
 * The start index (in daysOrder) of a preferred OFF window set as
 * produced by planPreferredOffWindows, or undefined if the set is not a
 * single cyclic block of exactly `windowLength` days. Used by the Stage-6.5
 * top-up to tie-break toward the pre-planned window.
 */
export function preferredWindowStart(daysOrder: string[], windowDays: ReadonlySet<string> | undefined, windowLength: number): number | undefined {
  if (!windowDays || windowDays.size !== windowLength) return undefined;
  for (let start = 0; start < daysOrder.length; start++) {
    if (cyclicWindowDays(daysOrder, start, windowLength).every((d) => windowDays.has(d))) return start;
  }
  return undefined;
}

/**
 * What Stage 6 needs, per generated day, to score tier 3 of the candidate
 * hierarchy (stage6-score-tiers.ts). Built by generate-draft-plan.ts's
 * runShiftGenerationPass.
 *
 * `previousDay`/`nextDay` are the calendar-adjacent days INSIDE this
 * displayed window, wrapping cyclically for a full 7-day window (Monday's
 * previous day is this same week's Sunday) — the SAME same-week
 * wraparound convention maxConsecutiveOffCyclic, the top-up's reservation
 * search and its Sunday->Monday wrap safety check already use. Omitted at
 * a non-wrapping window edge.
 */
export interface Stage6OffWindowContext {
  preferredOffDaysByEmployee: ReadonlyMap<string, ReadonlySet<string>>;
  previousDay?: { dayOfWeek: string; date: string };
  nextDay?: { dayOfWeek: string; date: string };
}

function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function nonOvernightCodesForDate(date: string): { entree: string; sortie: string }[] {
  return Object.values(shiftCatalogForDate(date)).filter(({ entree, sortie }) => timeToMinutes(sortie) > timeToMinutes(entree));
}

/**
 * True when a shift starting at `entreeMin` (minute of day) leaves NO
 * non-overnight catalog code on the previous day (resolved for its real
 * `previousDate`) that is rest-legal before it — i.e. rostering this code
 * forces the previous day to be OFF. Uses the same restHoursBetween model
 * as every Stage-6/6.5 legality check. `minimumRestHours <= 0` never forces
 * anything. Pure structural foresight for tier 3 — never itself a legality
 * decision (legality is still filtered separately, per employee).
 */
export function startForcesPreviousDayOff(entreeMin: number, previousDate: string, minimumRestHours: number): boolean {
  if (minimumRestHours <= 0) return false;
  const entree = minutesToTime(entreeMin);
  return !nonOvernightCodesForDate(previousDate).some((p) => restHoursBetween(p.entree, p.sortie, entree) >= minimumRestHours);
}

/** Mirror image of startForcesPreviousDayOff: a shift ending at `sortieMin` leaves no rest-legal non-overnight code on the next day. */
export function endForcesNextDayOff(entreeMin: number, sortieMin: number, nextDate: string, minimumRestHours: number): boolean {
  if (minimumRestHours <= 0) return false;
  const entree = minutesToTime(entreeMin);
  const sortie = minutesToTime(sortieMin);
  return !nonOvernightCodesForDate(nextDate).some((q) => restHoursBetween(entree, sortie, q.entree) >= minimumRestHours);
}

/**
 * Tier-3 structural conflicts (0-3) for one Stage-6 candidate — see
 * stage6-score-tiers.ts's hierarchy comment:
 *   (a) `dayOfWeek` is inside the employee's preferred OFF window;
 *   (b) the code forces the previous day OFF and that day is NOT in the
 *       window (a forced OFF day inside the window is harmless — it is
 *       already meant to be OFF);
 *   (c) the code forces the next day OFF outside the window.
 * An employee with no preferred window (not in the map) always scores 0.
 */
export function countOffWindowStructureConflicts(
  employeeId: string,
  dayOfWeek: string,
  forcesPreviousDayOff: boolean,
  forcesNextDayOff: boolean,
  context: Stage6OffWindowContext | undefined
): number {
  const window = context?.preferredOffDaysByEmployee.get(employeeId);
  if (!window) return 0;
  let conflicts = 0;
  if (window.has(dayOfWeek)) conflicts++;
  if (forcesPreviousDayOff && context!.previousDay && !window.has(context!.previousDay.dayOfWeek)) conflicts++;
  if (forcesNextDayOff && context!.nextDay && !window.has(context!.nextDay.dayOfWeek)) conflicts++;
  return conflicts;
}
