import { shiftCatalogForDate } from "../shift-templates";
import { flightDateFor } from "../flight-date";

/**
 * CAP-AWARE PER-EMPLOYEE ROSTER TARGET (2026-09-25, hard-constraints
 * milestone PHASE 2, part A).
 *
 * WHY THIS EXISTS. Phase 1 measured that the hard single-week hours cap
 * (Config.hard_weekly_hours_cap, 42h) and the old fixed "5 WORK + 2 OFF"
 * roster target are arithmetically incompatible for essentially every real
 * shift code: 5 x the SHORTEST non-overnight catalog code (NR01, 8.75h
 * before the 2026-09-20 GMT regime, 9h after) is 43.75h / 45h. The product
 * owner resolved it: the 42h cap stands, and "normal roster structure" now
 * means AS MANY work days as legally fit (up to the normal 5) under the hard
 * caps, given the employee's real shift-code options that week. A 4-work /
 * 3-OFF week genuinely forced by the hours cap is a NORMAL outcome, not an
 * anomaly — while a week that falls short of what was actually achievable
 * (e.g. 5 days would have fit, 4 were rostered) is still a finding.
 *
 * THE HEURISTIC (deterministic, documented; not a global optimum):
 *
 *   target = committed days + the largest j such that
 *            committed hours + the j CHEAPEST remaining days <= the cap,
 *   capped at the normal target (daysOrder.length - normal_weekly_off_days).
 *
 *   - "committed" days are the ones the employee already holds from real
 *     demand before the roster top-up runs: Stage 6 flexible-pool days, or a
 *     foreign-company member's flight days. Their REAL hours are used (the
 *     code actually generated, resolved per real date). They are treated as
 *     demand-justified: a longer demand code that consumes hours is not
 *     counted as an avoidable artifact (a documented simplification).
 *   - a remaining (free) day costs the SHORTEST non-overnight catalog code
 *     effective on that day's REAL date (shiftCatalogForDate — so a week
 *     straddling 2026-09-20 prices each side under its own regime). That is
 *     exactly the code family the top-up itself adds (shortest-first).
 *   - ties between equally cheap days go to calendar order (the choice of
 *     WHICH days does not change the count, only the arithmetic does).
 *   - when the cap is not binding at all, the target is simply the normal
 *     target — byte-identical to the pre-phase fixed number, so every
 *     caps-off / uncapped caller keeps its exact prior behaviour.
 *
 * What it deliberately does NOT model: the consecutive-work-day cap, 15h
 * rest, and qualifications for top-up days (top-up days are roster-shape
 * capacity, any catalog code is admissible). A shortfall caused by those is
 * therefore still BELOW the target and still reported — which is the point:
 * the target answers "how many days did the hours cap leave room for", and
 * anything short of that is a genuine, reportable shortfall.
 */

const HOURS_EPSILON = 1e-9;

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Duration (hours) of the shortest non-overnight catalog code effective on `date` — the cheapest real day the top-up could add. */
export function shortestNonOvernightCodeHours(date: string): number {
  let best = Number.POSITIVE_INFINITY;
  for (const { entree, sortie } of Object.values(shiftCatalogForDate(date))) {
    const d = timeToMinutes(sortie) - timeToMinutes(entree);
    if (d > 0 && d < best) best = d;
  }
  return best === Number.POSITIVE_INFINITY ? 0 : best / 60;
}

export interface CapAwareRosterTarget {
  /** The work-day count this employee should reach this window (<= normalTargetWorkDays). */
  targetWorkDays: number;
  /** The confirmed normal target (daysOrder.length - normal_weekly_off_days). */
  normalTargetWorkDays: number;
  /** True when the hard weekly hours cap, not the normal target, set targetWorkDays. */
  capLimited: boolean;
  /** Days and real hours already committed by demand before the top-up. */
  committedDays: number;
  committedHours: number;
  /** The hard weekly hours cap the arithmetic used. */
  hardWeeklyHoursCap: number;
  /** The cost (hours) assumed for each free day the target counts on, cheapest first. */
  assumedFreeDayHours: number[];
  /**
   * Filled in by generate-draft-plan.ts after the top-up: the free days that
   * were rest-legal but that a HARD CAP closed while this employee was still
   * below their target (the top-up's HardCapExclusion records). Non-empty =
   * the shortfall, if any, is attributable to the hard caps.
   */
  capClosedFreeDays?: string[];
}

/**
 * The cap-aware target for one employee (see the module doc comment).
 * `committedHoursByDay`: the employee's already-committed days -> real hours.
 * `freeDayHours` (optional): the assumed cost of a free day; defaults to the
 * shortest non-overnight catalog code on that day's real date.
 */
export function computeCapAwareTargetWorkDays(input: {
  daysOrder: string[];
  weekStart: string;
  normalTargetWorkDays: number;
  hardWeeklyHoursCap: number;
  committedHoursByDay?: ReadonlyMap<string, number>;
  freeDayHours?: (day: string, date: string) => number;
}): CapAwareRosterTarget {
  const { daysOrder, weekStart, normalTargetWorkDays, hardWeeklyHoursCap } = input;
  const committed = input.committedHoursByDay ?? new Map<string, number>();
  let committedDays = 0;
  let committedHours = 0;
  for (const day of daysOrder) {
    const h = committed.get(day);
    if (h === undefined) continue;
    committedDays++;
    committedHours += h;
  }
  const base = { normalTargetWorkDays, committedDays, committedHours, hardWeeklyHoursCap };
  if (committedDays >= normalTargetWorkDays) {
    return { ...base, targetWorkDays: normalTargetWorkDays, capLimited: false, assumedFreeDayHours: [] };
  }
  const cost = input.freeDayHours ?? ((_day: string, date: string) => shortestNonOvernightCodeHours(date));
  const free = daysOrder
    .map((day, index) => ({ day, index }))
    .filter(({ day }) => !committed.has(day))
    .map(({ day, index }) => ({ index, hours: cost(day, flightDateFor(weekStart, day)) }))
    .sort((a, b) => a.hours - b.hours || a.index - b.index);
  let hours = committedHours;
  const assumed: number[] = [];
  for (const f of free) {
    if (committedDays + assumed.length >= normalTargetWorkDays) break;
    if (hours + f.hours > hardWeeklyHoursCap + HOURS_EPSILON) break; // sorted cheapest-first: nothing later fits either
    hours += f.hours;
    assumed.push(f.hours);
  }
  const targetWorkDays = committedDays + assumed.length;
  // capLimited: the normal target was reachable by free-day count alone, but the hours cap stopped it.
  const capLimited = targetWorkDays < normalTargetWorkDays && committedDays + free.length >= normalTargetWorkDays;
  return { ...base, targetWorkDays, capLimited, assumedFreeDayHours: assumed };
}

/**
 * Length of the preferred consecutive OFF window (off-window.ts /
 * the top-up's reservation) for a given work-day target. Unchanged (the
 * confirmed normal_weekly_off_days) whenever the target is the normal one;
 * when the hours cap lowers the target, the week has MORE OFF days than
 * normal, but a single consecutive block of them must still respect
 * max_consecutive_off_days — so the window grows at most to that limit (with
 * today's confirmed 2 / 2 it stays 2, and the extra OFF day is placed
 * separately by the top-up's OFF-rule-aware search).
 */
export function preferredOffWindowLength(windowDays: number, targetWorkDays: number, normalWeeklyOffDays: number, maxConsecutiveOffDays: number): number {
  const offDays = Math.max(0, windowDays - targetWorkDays);
  if (offDays <= normalWeeklyOffDays) return normalWeeklyOffDays;
  return Math.max(normalWeeklyOffDays, Math.min(offDays, maxConsecutiveOffDays));
}
