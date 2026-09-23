import { Employee } from "../types";
import { TimeWindow } from "../scoring";
import { isTransitTeam, isFixedPlanningTeam, isRedeploymentAllowed } from "../teams";
import { isProfilingOrMesureAssigned, isForeignCompanyAssigned } from "./workforce-pools";

/**
 * 2026-09-23 ARCHITECTURE REFACTOR: this module used to also export
 * `computeDefaultCheckinZonePlacement`, which produced discrete
 * `ZoneCoverageDuty` rows (one per employee per free interval) that were
 * then PERSISTED as `checkin_zone_assignments` rows with
 * `source: "atlas_generated"`. That is exactly the architecture the
 * product owner's audit identified as the root cause of the
 * "Required 4 / Assigned 75" bug: a broad free-interval duty pinned, via a
 * single midpoint lookup, to ONE zone requirement row, then matched back
 * to a persisted row by a broken exact-window/first-match lookup
 * (weekly-plan-service.ts's old `findZoneRequirementIdFor`). Per the
 * owner's explicit instruction, default T1 placement is no longer
 * generated as discrete persisted duty rows at all — it is now DERIVED at
 * read time, atomic-interval by atomic-interval, by
 * lib/planning/checkin-capacity-timeline.ts, which reuses the eligibility
 * predicate below and `subtractBusyWindows`. See that module's doc
 * comment for the real Required/Available/Gap computation.
 *
 * `isEligibleForDefaultCheckinPlacement` and `subtractBusyWindows` remain
 * here, exported, as the shared primitives both the capacity-timeline
 * module and this module's own tests build on — this is still the one
 * true eligibility rule, never duplicated.
 *
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

/**
 * The one true default-T1-placement eligibility rule — exported so
 * lib/planning/checkin-capacity-timeline.ts (the derived Required/
 * Available/Gap computation that replaced this module's old discrete
 * duty generation) applies EXACTLY this same test, never a parallel
 * eligibility engine. See the module doc comment above for the rule
 * itself.
 */
export function isEligibleForDefaultCheckinPlacement(employee: Employee): boolean {
  if (!employee.active) return false;
  if (employee.is_duty_officer) return false;
  if (isFixedPlanningTeam(employee.assignment)) return false;
  if (isTransitTeam(employee.assignment)) return false;
  if (isProfilingOrMesureAssigned(employee)) return false;
  if (isForeignCompanyAssigned(employee) && !isRedeploymentAllowed(employee.assignment)) return false;
  if (!employee.skills.includes("Check-in")) return false;
  return true;
}
