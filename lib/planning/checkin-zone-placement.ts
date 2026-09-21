import { Employee, Config } from "../types";
import { TimeWindow } from "../scoring";
import { isTransitTeam, isFixedPlanningTeam, isRedeploymentAllowed } from "../teams";
import { isProfilingOrMesureAssigned, isForeignCompanyAssigned } from "./workforce-pools";
import { CheckinZoneId, ORDINARY_CHECKIN_ZONES } from "../checkin-zones";
import { ZoneDailyDemand } from "./zone-demand-aggregation";

/**
 * DEFAULT T1 CHECK-IN PLACEMENT — a genuinely different concept from
 * T1 Check-in DEMAND (zone-demand-aggregation.ts), per the product
 * owner's explicit instruction not to conflate the two:
 *
 *  - DEMAND answers "how many agents does this zone's real aggregated
 *    workload require" — that's `required_headcount` on a
 *    ZoneCheckinRequirement, and it must NEVER be inflated just because
 *    more idle capacity happens to be available.
 *  - DEFAULT PLACEMENT (this module) answers "where is an otherwise-idle
 *    rostered General T1 ACE (or other explicitly-eligible redeployable
 *    ACE) operationally positioned once their higher-priority duties are
 *    placed." If a zone requires 12 but 16 eligible employees are free,
 *    the requirement stays 12 while all 16 are still POSITIONED in T1
 *    Check-in rather than shown idle/OFF or given a fabricated flight
 *    duty — this module produces that placement, a coverage/gap metric
 *    must compare demand against required capacity, never against how
 *    many people this module happened to place.
 *
 * PRIORITY ORDER (confirmed, not to be re-derived here): this stage runs
 * strictly AFTER a day's specific flight/specialized/company duties
 * (Gate, Boarding, Profiling, Mesure, foreign-company commitments) are
 * already placed — those are passed in as `busyWindows`
 * (computeBusyWindowsForDay's own output, extended with this same day's
 * freshly generated duties — see duty-generation.ts), never recomputed or
 * second-guessed here. This stage only fills what's left of an eligible
 * employee's shift.
 *
 * ELIGIBILITY (reuses existing predicates/rules — never a parallel
 * eligibility engine):
 *  - Must be in the day-effective candidate pool (rostered WORK, has a
 *    real effective shift for today — same population duty-generation
 *    itself scores against).
 *  - Active, not a Duty Officer, not on a FIXED_PLANNING_TEAM
 *    (isFixedPlanningTeam) — those follow specialized planning, never
 *    general ACE allocation.
 *  - Never Transit (isTransitTeam) — hard, non-configurable exclusion,
 *    exactly as isRedeploymentAllowed itself enforces.
 *  - Never currently placed on Profiling/Mesure (isProfilingOrMesureAssigned)
 *    — that is their own team's real commitment, not idle time.
 *  - A foreign-company-assigned employee (isForeignCompanyAssigned) is
 *    eligible ONLY when isRedeploymentAllowed(employee.assignment) is
 *    true for their team — reusing the exact same redeployment policy
 *    scoring/duty-generation already apply, never a bespoke check. Being
 *    outside their protected window is already guaranteed by construction
 *    here: a protected-window interval is part of `busyWindows` and is
 *    therefore never part of a computed FREE interval in the first place.
 *  - Must hold the Check-in skill/qualification (`skills.includes("Check-in")`)
 *    — see checkin-zones.ts's module doc comment on zone-specific
 *    qualifications being an explicit future extension point, not
 *    something this prototype invents.
 *
 * OUTPUT: for each eligible employee, their shift interval MINUS every
 * busy window (already-placed duties/commitments) produces zero or more
 * FREE sub-intervals — each becomes one ZoneCoverageDuty, so an
 * employee's timeline never has overlapping blocks and a single
 * placement duty never spans across an existing commitment. A short
 * residual sliver (governed by MINIMUM_PLACEMENT_MINUTES) is deliberately
 * dropped rather than producing a duty too short to represent real
 * counter coverage — this mirrors the existing convention (elsewhere in
 * this codebase) of never fabricating a duty from operationally
 * meaningless residual time.
 */
export interface ZoneCoverageDuty {
  employeeId: string;
  zone: CheckinZoneId;
  dayOfWeek: string;
  window: TimeWindow;
  reasoning: string;
}

const MINIMUM_PLACEMENT_MINUTES = 30;

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutesToTime(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** Subtracts every busy window from [start,end], returning the remaining free sub-intervals in order. Pure interval arithmetic — no employee/zone knowledge. */
export function subtractBusyWindows(shift: TimeWindow, busy: TimeWindow[]): TimeWindow[] {
  let free: { start: number; end: number }[] = [{ start: timeToMinutes(shift.start), end: timeToMinutes(shift.end) }];

  for (const b of busy) {
    const bStart = timeToMinutes(b.start);
    const bEnd = timeToMinutes(b.end);
    const next: { start: number; end: number }[] = [];
    for (const f of free) {
      if (bEnd <= f.start || bStart >= f.end) {
        next.push(f); // no overlap
        continue;
      }
      if (bStart > f.start) next.push({ start: f.start, end: Math.min(bStart, f.end) });
      if (bEnd < f.end) next.push({ start: Math.max(bEnd, f.start), end: f.end });
    }
    free = next;
  }

  return free
    .filter((f) => f.end - f.start >= MINIMUM_PLACEMENT_MINUTES)
    .map((f) => ({ start: minutesToTime(f.start), end: minutesToTime(f.end) }));
}

function isEligibleForDefaultCheckinPlacement(employee: Employee): boolean {
  if (!employee.active) return false;
  if (employee.is_duty_officer) return false;
  if (isFixedPlanningTeam(employee.assignment)) return false;
  if (isTransitTeam(employee.assignment)) return false;
  if (isProfilingOrMesureAssigned(employee)) return false;
  if (isForeignCompanyAssigned(employee) && !isRedeploymentAllowed(employee.assignment)) return false;
  if (!employee.skills.includes("Check-in")) return false;
  return true;
}

/** Picks the ordinary zone with the highest required headcount overlapping the given interval's midpoint — a plausible, demand-informed default location, never itself a claim about required capacity (see the module doc comment's DEMAND vs PLACEMENT distinction). Falls back to t1_main_checkin, the largest/general zone, when no zone has any demand at that moment (still a valid place to operationally position someone, since the zone genuinely exists and idle capacity there is normal). */
function pickDefaultZone(midpointMinutes: number, zoneDemand: Partial<Record<CheckinZoneId, ZoneDailyDemand>>): CheckinZoneId {
  let best: CheckinZoneId = "t1_main_checkin";
  let bestRequired = -1;
  for (const zone of ORDINARY_CHECKIN_ZONES) {
    const daily = zoneDemand[zone];
    if (!daily) continue;
    const bucket = daily.buckets.find((b) => timeToMinutes(b.start) <= midpointMinutes && midpointMinutes < timeToMinutes(b.end));
    const required = bucket?.required ?? 0;
    if (required > bestRequired) {
      bestRequired = required;
      best = zone;
    }
  }
  return best;
}

/**
 * The default-placement stage itself: given the day-effective pool, each
 * employee's shift window, and every busy window already consumed by
 * higher-priority duties this day (Gate/Boarding/Profiling/Mesure/
 * foreign-company — passed in exactly as computed by
 * duty-generation.ts's computeBusyWindowsForDay plus this same day's own
 * generated duties), produces zero or more ZoneCoverageDuty rows per
 * eligible employee for their remaining free time.
 */
export function computeDefaultCheckinZonePlacement(
  dayOfWeek: string,
  dayEffectivePool: (Employee & { shift_start: string; shift_end: string })[],
  busyWindows: Record<string, TimeWindow[]>,
  zoneDemand: Partial<Record<CheckinZoneId, ZoneDailyDemand>>
): ZoneCoverageDuty[] {
  const duties: ZoneCoverageDuty[] = [];

  for (const employee of dayEffectivePool) {
    if (!isEligibleForDefaultCheckinPlacement(employee)) continue;

    const shiftWindow: TimeWindow = { start: employee.shift_start, end: employee.shift_end };
    const free = subtractBusyWindows(shiftWindow, busyWindows[employee.id] ?? []);

    for (const interval of free) {
      const midpoint = (timeToMinutes(interval.start) + timeToMinutes(interval.end)) / 2;
      const zone = pickDefaultZone(midpoint, zoneDemand);
      duties.push({
        employeeId: employee.id,
        zone,
        dayOfWeek,
        window: interval,
        reasoning: `Default T1 Check-in placement — ${employee.name} has no specific flight/specialized duty during ${interval.start}–${interval.end} while rostered WORK; positioned in the zone with the highest concurrent demand at that time (prototype placement heuristic, not itself a claim about required headcount — see lib/planning/checkin-zone-placement.ts).`,
      });
    }
  }

  return duties;
}
