/**
 * Shared low-level roster-building helpers. The OFF-day COUNT and
 * PLACEMENT logic that used to live here (deriving days-off from a
 * weekly-hours ceiling) has been removed — there is no confirmed ceiling
 * to derive it from (see lib/labor-rules.ts), and the confirmed rule is a
 * flat OFF-day count applied directly, with a foreign-company team's
 * actual OFF-day placement derived by the generic Rotation Feasibility
 * Engine (lib/rotation-feasibility.ts) instead. What remains here:
 * buildStaggeredOffDays (a generic "spread N off-days across a group,
 * preferring given days" placement helper, still used for teams with no
 * operational-demand rotation question to answer) and restHoursBetween
 * (the shared rest-hours-between-shifts calculation).
 */

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
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
