import { Employee, Flight, Assignment, StaffingRequirement, WeeklyPlanRosterEntry } from "../types";
import { TimeWindow } from "../scoring";
import { CheckinZoneId, ORDINARY_CHECKIN_ZONES } from "../checkin-zones";
import {
  ZoneCheckinDemandPolicy,
  DEFAULT_ZONE_CHECKIN_DEMAND_POLICY,
  getFlightCheckinWindow,
  checkinIncrementForFlight,
  zoneBaseAgents,
  zoneMinimumPerActiveFlight,
} from "./checkin-zone-demand";
import { isEligibleForDefaultCheckinPlacement } from "./checkin-zone-placement";
import { computeBusyWindowsForDay, buildDayEffectivePoolFromRosterEntries } from "./duty-generation";
import { CheckinDemandPolicy } from "./checkin-demand";

/**
 * DERIVED T1 CHECK-IN CAPACITY TIMELINE — 2026-09-23 architecture refactor.
 *
 * This module REPLACES the old "generate a discrete ZoneCoverageDuty per
 * employee per free interval, then persist it as a checkin_zone_assignments
 * row" pipeline (checkin-zone-placement.ts's now-removed
 * computeDefaultCheckinZonePlacement, wired through weekly-plan-service.ts's
 * now-removed findZoneRequirementIdFor). That pipeline is what produced the
 * live "04:00–08:30 Main Check-in — Required 4 / Assigned 75" bug: a broad
 * free-interval duty (an employee's whole idle stretch of a shift) was
 * matched back to a SINGLE zone-requirement row by an exact-window lookup
 * that almost never hit, falling back to "the first requirement row for
 * this zone/day" with NO overlap check at all — so nearly every placement
 * duty for a zone/day landed on the day's earliest demand cluster.
 *
 * The fix is architectural, not a patched lookup (per the product owner's
 * explicit instruction): T1 Check-in coverage is not a separately assigned
 * duty type at all. It is the RESIDUE of an employee's rostered shift once
 * every real, already-computed specific-duty interval (Gate/Boarding/
 * Profiling/Mesure/foreign-company protected windows) is subtracted —
 * evaluated as a TIMELINE of ATOMIC PERIODS bounded by real events (a
 * flight's Check-in-open/close instant, a shift start/end, a specific-duty
 * start/end), never as one broad window smeared across a whole cluster.
 *
 * Two separate timelines are built and then compared, exactly as the
 * product owner specified:
 *  - DEMAND: for each ordinary zone, at any instant, how many flights are
 *    simultaneously Check-in-open there (reusing checkin-zone-demand.ts's
 *    prototype coefficients — see requiredForZoneAtInstant below).
 *  - CAPACITY: for each eligible employee (isEligibleForDefaultCheckinPlacement,
 *    reused unchanged from checkin-zone-placement.ts), whether they are
 *    inside their shift and outside every real busy interval at that same
 *    instant (reusing duty-generation.ts's computeBusyWindowsForDay, the
 *    exact same real-interval source duty-generation itself uses — never
 *    recomputed or approximated here).
 *
 * The free-employee pool at a given instant is SPLIT across every ordinary
 * zone with unmet demand at that same instant (see attributeFreeEmployees-
 * ForInstant below), greedily filling whichever zone has the largest
 * remaining gap (required minus already-attributed) one employee at a
 * time, and only parking surplus on the single highest-demand zone once
 * every zone's requirement is fully covered (or every zone is at zero
 * demand). This REPLACES an earlier, narrower heuristic (2026-09-23
 * refactor) that attributed the ENTIRE free pool to whichever single zone
 * had the highest required headcount, using the same static per-instant
 * requiredByZone snapshot for every employee in the loop — so whenever two
 * ordinary zones had simultaneous real demand (e.g. Main + Domestic, or
 * Main + Italy/Spain at the same instant), 100% of the free pool landed on
 * the busiest zone and every other zone showed Available 0 even though the
 * pool, split sensibly, would have covered all of them. This is the exact
 * live-production bug traced on 2026-09-23: T1 Domestic and T1 Italy/Spain
 * showing a persistent Required 2 / Available 0 / Gap 2 in windows that DID
 * overlap active shifts, while T1 Main showed a comfortable surplus at the
 * same instant — every free employee was being attributed to Main alone.
 *
 * This attribution (now split-aware) is still evaluated ONCE PER ATOMIC
 * PERIOD, never once per whole shift, so a partial-interval overlap can
 * never be counted as full-window coverage. This is what makes the
 * FK-matching bug structurally impossible to recur: there is no separate
 * persisted row to mis-link in the first place. Adjacent atomic periods
 * with identical (required, available) values are merged only for DISPLAY
 * (mergeAtomicPeriodsForZone below) — the underlying per-instant
 * computation is always atomic-correct first.
 *
 * HONEST LIMITATION of the split-aware attribution itself: this is a
 * greedy, per-instant, max-remaining-gap fill — NOT a true joint optimizer
 * across all zones and all atomic periods simultaneously. It always
 * produces the max-min-fair split for a single instant (no zone is left at
 * a bigger gap than another while a different zone already has surplus),
 * but it cannot "save" capacity from one atomic period for a harder one a
 * few minutes later, nor trade an employee's zone assignment across
 * periods to reduce churn in EmployeeZoneAvailabilitySegment (see that
 * function below). An extremely tight multi-zone conflict that shifts
 * shape every few minutes could still show more zone-attribution changes
 * than a hypothetical whole-shift optimizer would choose — the Required/
 * Available/Gap numbers are always correct at each instant regardless.
 *
 * KNOWN, DELIBERATE LIMITATIONS (unchanged from the modules this reuses,
 * not introduced here):
 *  - A flight's Check-in-open window is clamped to [00:00, departure) for
 *    that same calendar day (see checkin-zone-demand.ts's
 *    getFlightCheckinWindow) — an early-morning flight's window does not
 *    reach back into the previous day. This mirrors the existing
 *    zone-demand-aggregation.ts bucket model exactly; fixing cross-day
 *    flight windows is out of scope here.
 *  - An overnight employee shift (shift_end numerically before
 *    shift_start) is not unwrapped across midnight, exactly like
 *    subtractBusyWindows already behaves — again a pre-existing modeling
 *    limitation, not something this refactor introduces or is asked to fix.
 */

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(mins: number): string {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

/** One eligible employee's real, already-computed availability inputs for one day — a shift window and every real busy interval consumed by higher-priority duties/commitments that day. Never a claim about which zone they belong to (see the module doc comment on point 6: attribution is per-instant, not permanent). */
export interface EmployeeAvailabilityInput {
  employeeId: string;
  shift: TimeWindow;
  busyWindows: TimeWindow[];
}

/** One atomic period's Required (per zone) and Available (per zone) — constant throughout the period by construction (see buildDailyCapacityTimeline). */
export interface CapacityAtomicPeriod {
  start: string;
  end: string;
  requiredByZone: Partial<Record<CheckinZoneId, number>>;
  contributingFlightIdsByZone: Partial<Record<CheckinZoneId, string[]>>;
  availableByZone: Partial<Record<CheckinZoneId, number>>;
  availableEmployeeIdsByZone: Partial<Record<CheckinZoneId, string[]>>;
}

/** One DISPLAY row — zero or more adjacent atomic periods merged because they share identical Required/Available for this one zone (see mergeAtomicPeriodsForZone). This is the shape components render; the atomic computation behind it is never smeared. */
export interface ZoneCoverageRow {
  zone: CheckinZoneId;
  dayOfWeek: string;
  start: string;
  end: string;
  required: number;
  available: number;
  gap: number;
  surplus: number;
  contributingFlightIds: string[];
  availableEmployeeIds: string[];
}

function requiredForZoneAtInstant(
  zone: CheckinZoneId,
  tMinutes: number,
  flights: Flight[],
  policy: ZoneCheckinDemandPolicy
): { required: number; flightIds: string[] } {
  let incrementSum = 0;
  let activeCount = 0;
  const flightIds: string[] = [];

  for (const flight of flights) {
    const contribution = checkinIncrementForFlight(flight, policy);
    if (!contribution || contribution.zone !== zone) continue;
    const window = getFlightCheckinWindow(flight, policy);
    const startMin = timeToMinutes(window.start);
    const endMin = timeToMinutes(window.end);
    if (startMin <= tMinutes && tMinutes < endMin) {
      incrementSum += contribution.increment;
      activeCount += 1;
      flightIds.push(flight.id);
    }
  }

  if (activeCount === 0) return { required: 0, flightIds: [] };
  const base = zoneBaseAgents(zone, policy);
  const floor = zoneMinimumPerActiveFlight(zone, policy) * activeCount;
  return { required: Math.max(floor, base + incrementSum), flightIds };
}

function isFreeAtInstant(availability: EmployeeAvailabilityInput, tMinutes: number): boolean {
  const shiftStart = timeToMinutes(availability.shift.start);
  const shiftEnd = timeToMinutes(availability.shift.end);
  if (!(shiftStart <= tMinutes && tMinutes < shiftEnd)) return false;
  for (const busy of availability.busyWindows) {
    const busyStart = timeToMinutes(busy.start);
    const busyEnd = timeToMinutes(busy.end);
    if (busyStart <= tMinutes && tMinutes < busyEnd) return false;
  }
  return true;
}

/** Fallback zone for surplus capacity once every ordinary zone's demand is fully covered (or every zone is at zero demand): the single highest-required zone, same tie-break as the old single-zone heuristic this replaces. */
function highestDemandZone(requiredByZone: Partial<Record<CheckinZoneId, number>>): CheckinZoneId {
  let best: CheckinZoneId = "t1_main_checkin";
  let bestRequired = -1;
  for (const zone of ORDINARY_CHECKIN_ZONES) {
    const required = requiredByZone[zone] ?? 0;
    if (required > bestRequired) {
      bestRequired = required;
      best = zone;
    }
  }
  return best;
}

/**
 * Splits the free-employee pool at one instant across every ordinary zone
 * with unmet demand, instead of concentrating it entirely into the single
 * highest-demand zone (see the module doc comment for the live bug this
 * fixes). Greedy max-remaining-gap fill: each free employee, in order, is
 * attributed to whichever zone currently has the LARGEST unmet need
 * (required minus already-attributed-so-far in this same instant) — so
 * simultaneous demand in two or more zones is genuinely split between them,
 * and a zone whose requirement is already fully covered by attribution
 * receives no more of the pool while another zone still has a gap. Once
 * every zone's requirement is fully covered (or every zone is at zero
 * demand), remaining surplus employees are parked on the single
 * highest-demand zone, same as the previous behavior for that case.
 *
 * This is a per-instant, max-min-fair greedy split, not a true joint
 * optimizer across zones and time (see the module doc comment's HONEST
 * LIMITATION note) — it never fabricates coverage a genuinely undersized
 * pool cannot provide, it only stops wasting pool capacity on a single
 * zone that is already fully covered while a sibling zone starves.
 */
function attributeFreeEmployeesForInstant(
  requiredByZone: Partial<Record<CheckinZoneId, number>>,
  freeEmployeeIds: string[]
): {
  availableByZone: Partial<Record<CheckinZoneId, number>>;
  availableEmployeeIdsByZone: Partial<Record<CheckinZoneId, string[]>>;
} {
  const availableByZone: Partial<Record<CheckinZoneId, number>> = {};
  const availableEmployeeIdsByZone: Partial<Record<CheckinZoneId, string[]>> = {};
  const fallbackZone = highestDemandZone(requiredByZone);

  for (const employeeId of freeEmployeeIds) {
    let target: CheckinZoneId | null = null;
    let bestUnmet = 0;
    for (const zone of ORDINARY_CHECKIN_ZONES) {
      const required = requiredByZone[zone] ?? 0;
      const alreadyAttributed = availableByZone[zone] ?? 0;
      const unmet = required - alreadyAttributed;
      if (unmet > bestUnmet) {
        bestUnmet = unmet;
        target = zone;
      }
    }
    // No zone has any unmet demand left at this point in the allocation
    // (every zone's requirement is already fully covered by employees
    // attributed earlier in this same instant, or every zone is at zero
    // demand): surplus capacity is parked on the single highest-demand
    // zone, exactly like the previous single-zone heuristic did.
    if (!target) target = fallbackZone;

    availableByZone[target] = (availableByZone[target] ?? 0) + 1;
    availableEmployeeIdsByZone[target] = [...(availableEmployeeIdsByZone[target] ?? []), employeeId];
  }

  return { availableByZone, availableEmployeeIdsByZone };
}

/**
 * Builds the day's shared atomic-interval timeline: collects every real
 * event boundary (flight Check-in-open/close instants, employee shift
 * start/end, employee busy-interval start/end) across ALL ordinary zones
 * and ALL eligible employees, sorts + dedupes them, and evaluates
 * Required-per-zone and Available-per-zone ONCE per resulting atomic
 * period (using the period's start instant, which is valid for the whole
 * period by construction — no boundary falls strictly inside it).
 */
export function buildDailyCapacityTimeline(
  dayOfWeek: string,
  flights: Flight[],
  eligibleEmployees: EmployeeAvailabilityInput[],
  policy: ZoneCheckinDemandPolicy = DEFAULT_ZONE_CHECKIN_DEMAND_POLICY
): CapacityAtomicPeriod[] {
  const dayFlights = flights.filter((f) => f.day_of_week === dayOfWeek);

  const boundaries = new Set<number>();
  boundaries.add(0);
  boundaries.add(1440);

  for (const flight of dayFlights) {
    // Only flights that actually contribute to SOME ordinary zone's demand
    // matter as boundaries — a flight bound for a manual zone (Business/
    // Staff/Oversized) or an unclassifiable destination never changes any
    // ordinary zone's required headcount, so it should not fragment the
    // timeline with a no-op boundary.
    const contribution = checkinIncrementForFlight(flight, policy);
    if (!contribution) continue;
    const window = getFlightCheckinWindow(flight, policy);
    boundaries.add(timeToMinutes(window.start));
    boundaries.add(timeToMinutes(window.end));
  }

  for (const availability of eligibleEmployees) {
    boundaries.add(timeToMinutes(availability.shift.start));
    boundaries.add(timeToMinutes(availability.shift.end));
    for (const busy of availability.busyWindows) {
      boundaries.add(timeToMinutes(busy.start));
      boundaries.add(timeToMinutes(busy.end));
    }
  }

  const sorted = Array.from(boundaries)
    .filter((m) => m >= 0 && m <= 1440)
    .sort((a, b) => a - b);

  const periods: CapacityAtomicPeriod[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end <= start) continue;

    const requiredByZone: Partial<Record<CheckinZoneId, number>> = {};
    const contributingFlightIdsByZone: Partial<Record<CheckinZoneId, string[]>> = {};
    for (const zone of ORDINARY_CHECKIN_ZONES) {
      const { required, flightIds } = requiredForZoneAtInstant(zone, start, dayFlights, policy);
      requiredByZone[zone] = required;
      contributingFlightIdsByZone[zone] = flightIds;
    }

    const freeEmployeeIds = eligibleEmployees
      .filter((availability) => isFreeAtInstant(availability, start))
      .map((availability) => availability.employeeId);
    const { availableByZone, availableEmployeeIdsByZone } = attributeFreeEmployeesForInstant(requiredByZone, freeEmployeeIds);

    periods.push({
      start: minutesToTime(start),
      end: minutesToTime(end),
      requiredByZone,
      contributingFlightIdsByZone,
      availableByZone,
      availableEmployeeIdsByZone,
    });
  }

  return periods;
}

/**
 * Display-layer merge ONLY (per the product owner's explicit instruction:
 * "merging only as a display-layer convenience, never a computation
 * shortcut" — the atomic computation above has already run). Adjacent
 * atomic periods for ONE zone are collapsed into one row when they share
 * identical required/available; a row is only emitted when there is
 * something real to show (required > 0 or available > 0) — a period where
 * a zone has neither demand nor attributed capacity is not an
 * operationally meaningful row.
 */
export function mergeAtomicPeriodsForZone(zone: CheckinZoneId, dayOfWeek: string, periods: CapacityAtomicPeriod[]): ZoneCoverageRow[] {
  const rows: ZoneCoverageRow[] = [];

  for (const period of periods) {
    const required = period.requiredByZone[zone] ?? 0;
    const available = period.availableByZone[zone] ?? 0;
    if (required === 0 && available === 0) continue;

    const contributingFlightIds = period.contributingFlightIdsByZone[zone] ?? [];
    const availableEmployeeIds = period.availableEmployeeIdsByZone[zone] ?? [];

    const last = rows[rows.length - 1];
    if (
      last &&
      last.end === period.start &&
      last.required === required &&
      last.available === available &&
      sameSet(last.contributingFlightIds, contributingFlightIds) &&
      sameSet(last.availableEmployeeIds, availableEmployeeIds)
    ) {
      last.end = period.end;
      continue;
    }

    rows.push({
      zone,
      dayOfWeek,
      start: period.start,
      end: period.end,
      required,
      available,
      gap: Math.max(0, required - available),
      surplus: Math.max(0, available - required),
      contributingFlightIds,
      availableEmployeeIds,
    });
  }

  return rows;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const id of b) if (!setA.has(id)) return false;
  return true;
}

/**
 * ONE employee's DERIVED default T1 coverage segment for a day — never a
 * persisted duty (see the module doc comment on point 6): this employee
 * has no specific duty during [start,end) while rostered WORK, and `zone`
 * is where the demand-informed heuristic attributes them at that time.
 */
export interface EmployeeZoneAvailabilitySegment {
  zone: CheckinZoneId;
  start: string;
  end: string;
}

/**
 * Merges consecutive atomic periods into per-employee display segments —
 * the Agent Schedule / Agent Day Detail equivalent of
 * mergeAtomicPeriodsForZone, keyed by employee instead of by zone. Two
 * adjacent periods merge only when this employee is free in BOTH and
 * attributed to the SAME zone in both — an attribution change (the
 * heuristic switches which zone has the highest demand) always starts a
 * new segment, never silently absorbed into a wider one.
 */
export function buildEmployeeZoneAvailabilitySegments(employeeId: string, periods: CapacityAtomicPeriod[]): EmployeeZoneAvailabilitySegment[] {
  const segments: EmployeeZoneAvailabilitySegment[] = [];

  for (const period of periods) {
    let zoneForEmployee: CheckinZoneId | null = null;
    for (const zone of ORDINARY_CHECKIN_ZONES) {
      if ((period.availableEmployeeIdsByZone[zone] ?? []).includes(employeeId)) {
        zoneForEmployee = zone;
        break;
      }
    }
    if (!zoneForEmployee) continue;

    const last = segments[segments.length - 1];
    if (last && last.end === period.start && last.zone === zoneForEmployee) {
      last.end = period.end;
      continue;
    }
    segments.push({ zone: zoneForEmployee, start: period.start, end: period.end });
  }

  return segments;
}

/**
 * Reconstructs this day's EmployeeAvailabilityInput[] from already-
 * PERSISTED rows only (roster entries + flight-anchored assignments) — the
 * whole point of the "derived at read time" architecture: no
 * checkin_zone_assignments row is needed to answer "who is free right
 * now." Reuses buildDayEffectivePoolFromRosterEntries (real shift times
 * for the day, including any generated shift-code choice) and
 * computeBusyWindowsForDay (the exact same real busy-interval source
 * duty-generation.ts itself uses for Gate/Boarding/Profiling/Mesure/
 * foreign-company-protected-window busy time) — never a parallel
 * reconstruction of either.
 */
export function buildEligibleEmployeeAvailabilityForDay(
  dayOfWeek: string,
  employees: Employee[],
  rosterEntries: WeeklyPlanRosterEntry[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  checkinPolicy?: CheckinDemandPolicy
): EmployeeAvailabilityInput[] {
  const dayEffectivePool = buildDayEffectivePoolFromRosterEntries(employees, rosterEntries, dayOfWeek);
  const eligiblePool = dayEffectivePool.filter(isEligibleForDefaultCheckinPlacement) as (Employee & {
    shift_start: string;
    shift_end: string;
  })[];

  const busyWindows = computeBusyWindowsForDay(dayOfWeek, assignments, requirements, flights, eligiblePool, checkinPolicy);

  return eligiblePool.map((employee) => ({
    employeeId: employee.id,
    shift: { start: employee.shift_start, end: employee.shift_end },
    busyWindows: busyWindows[employee.id] ?? [],
  }));
}

/**
 * Convenience wrapper combining the two steps above: this day's derived
 * capacity timeline for ALL ordinary zones, keyed by zone, already merged
 * for display. This is the function persisted-plan-view.ts (read time) and
 * generate-draft-plan.ts (generation time, for the plan-generation summary
 * only — see that file) call; neither builds the atomic timeline
 * differently.
 */
export function buildZoneCoverageRowsForDay(
  dayOfWeek: string,
  flights: Flight[],
  eligibleEmployees: EmployeeAvailabilityInput[],
  policy: ZoneCheckinDemandPolicy = DEFAULT_ZONE_CHECKIN_DEMAND_POLICY
): Record<CheckinZoneId, ZoneCoverageRow[]> {
  const periods = buildDailyCapacityTimeline(dayOfWeek, flights, eligibleEmployees, policy);
  const result = {} as Record<CheckinZoneId, ZoneCoverageRow[]>;
  for (const zone of ORDINARY_CHECKIN_ZONES) {
    result[zone] = mergeAtomicPeriodsForZone(zone, dayOfWeek, periods);
  }
  return result;
}
