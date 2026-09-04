import { SHIFT_CODES } from "./shift-templates";

/**
 * How the synthetic weekly roster is built. The prior generator gave every
 * employee exactly one OFF day regardless of shift length, which made a
 * weekly-hours violation mathematically inevitable for anyone on a shift
 * longer than ~6h40 (40h / 6 working days) — this was the actual root
 * cause of the near-universal weekly-hours violations, not missing
 * General T1 demand. This module fixes that by deriving how many days a
 * given shift can be worked without crossing the fairness ceiling, then
 * distributing OFF days across a group so coverage still varies day to
 * day (not everyone off the same day).
 *
 * This is a prototype-safe scheduling STRATEGY, not a claim about real
 * RAM rotation rules. Real rotation patterns for most teams (Leaders,
 * Duty Officers, Caisse/BCB, specialized teams) remain TBD — this module
 * does not invent detailed rules for them; it applies the same
 * ceiling-respecting, staggered-OFF-day approach uniformly, which is
 * honest about being a placeholder rather than a researched rotation.
 */

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Duration of a catalog shift code, in hours, handling overnight-crossing shifts. */
export function shiftDurationHours(code: string): number {
  const times = SHIFT_CODES[code];
  if (!times) {
    throw new Error(`Unknown shift code "${code}" — not in the authoritative shift catalog.`);
  }
  let minutes = timeToMinutes(times.sortie) - timeToMinutes(times.entree);
  if (minutes < 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 100) / 100;
}

/**
 * The most days a given shift can be worked in a week without exceeding
 * ceilingHours — never forces exactly the ceiling, just caps at it.
 * Clamped to [1, 6]: never zero working days (that's not a roster, that's
 * an inactive employee), never a full 7-day week (everyone gets at least
 * one day off, matching real staffing practice even when the ceiling
 * alone would technically allow more).
 */
export function maxWorkingDaysForShift(shiftCode: string, ceilingHours: number): number {
  const duration = shiftDurationHours(shiftCode);
  const byCeiling = Math.floor(ceilingHours / duration);
  return Math.max(1, Math.min(6, byCeiling));
}

/**
 * Picks offDaysCount distinct OFF days for one employee out of a 7-day
 * week, out of candidatePool (the days that are allowed to be OFF at
 * all — e.g. excluding Wednesday for a role scoring.ts queries live).
 *
 * preferredOffDays, when given, are tried first (e.g. a foreign-company
 * employee's non-flight days) — this is what keeps OFF-day selection
 * from being independent of protected commitments: a day the employee's
 * company actually flies is only chosen as OFF if there aren't enough
 * non-flight candidate days to cover offDaysCount. When a company flies
 * every day (no non-flight day exists at all), this necessarily falls
 * back to the full pool — a real, honestly-reported constraint, not a
 * bug to hide.
 *
 * employeeIndexInGroup rotates the starting point through the ordered
 * pool so different members of the same group land on different OFF
 * days (real day-to-day coverage variety), rather than everyone in a
 * category sharing an identical pattern.
 */
export function buildStaggeredOffDays(
  employeeIndexInGroup: number,
  offDaysCount: number,
  candidatePool: string[],
  preferredOffDays?: string[]
): string[] {
  if (candidatePool.length === 0 || offDaysCount <= 0) return [];

  const preferred = (preferredOffDays ?? []).filter((d) => candidatePool.includes(d));
  const rest = candidatePool.filter((d) => !preferred.includes(d));
  const ordered = [...preferred, ...rest];

  // Rotate the starting point per employee, wrapping around the full
  // ordered list, so consecutive employees don't pick an identical set.
  const rotated = ordered.map((_, i) => ordered[(i + employeeIndexInGroup) % ordered.length]);

  const chosen: string[] = [];
  for (const day of rotated) {
    if (chosen.length >= offDaysCount) break;
    if (!chosen.includes(day)) chosen.push(day);
  }
  return chosen;
}

/**
 * Convenience: how many OFF days a shift needs (out of a 7-day week) to
 * stay at or under ceilingHours. `7 - maxWorkingDaysForShift(...)`.
 */
export function offDaysCountForShift(shiftCode: string, ceilingHours: number): number {
  return 7 - maxWorkingDaysForShift(shiftCode, ceilingHours);
}

/**
 * Rest hours between the end of one working day's shift and the start of
 * the NEXT calendar day's shift — prevShiftEnd is read on today's clock,
 * nextShiftStart on tomorrow's. This is the exact same rest definition
 * lib/planning/validation.ts's week-level rest check already uses
 * (checkRestBetweenDays); it's factored out here so shift SELECTION
 * (Stage 6) can apply the identical rule when choosing a shift, instead of
 * only detecting the violation after the fact. Not a new or looser
 * definition of rest — same math, one implementation.
 */
export function restHoursBetween(prevShiftEnd: string, nextShiftStart: string): number {
  const endMin = timeToMinutes(prevShiftEnd);
  const startMin = timeToMinutes(nextShiftStart) + 24 * 60; // next calendar day
  return (startMin - endMin) / 60;
}
