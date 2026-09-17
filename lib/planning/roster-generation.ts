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
 * CRITICAL BACKWARD-COMPATIBILITY CONTRACT: while
 * `config.working_hours_obligation_hours` is `null` (today's real-world
 * default — see labor-rules.ts, still unconfirmed), this module is a
 * genuine NO-OP / pass-through. `generateObligationToppedUpShifts` then
 * returns an empty assignment list for every day, so merging its output
 * into the demand-driven Stage 6/7 result changes nothing at all —
 * behavior stays byte-for-byte identical to before this module existed.
 * Only once a real obligation number is confirmed and configured does
 * this stage do anything: TOP UP a flexible-pool employee's real
 * demand-driven schedule with additional rostered (not demand-justified)
 * days, until their pro-rated target for this window is met or no more
 * LEGAL day is available. A day added here is a real, honest "working,
 * available capacity" day — not a fabricated flight duty; Stage 9
 * (duty-generation.ts) is free to fill part of it with real work, or
 * leave it as genuine idle/available capacity, exactly as the
 * known-limitations doc describes.
 *
 * This function never overrides or removes a demand-driven day, never
 * pushes an employee below the confirmed minimum OFF days
 * (`config.normal_weekly_off_days`) for this displayed window, and never
 * offers an illegal (rest-violating) shift — a day it can't legally cover
 * is simply left as a real shortfall against the obligation, exactly like
 * every other honest-gap convention in this codebase (see
 * specialized-team-generation.ts's DemandConflict). The universal
 * whole-week rest safety net (shift-generation.ts's
 * enforceRestInvariantAcrossWeek) still re-validates everything this
 * stage adds, as the final backstop, same as every other generation
 * source.
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
 * The continuous-roster-generation stage itself. Returns, per day, the
 * ADDITIONAL flexible-pool shift assignments needed to move each
 * employee toward their working-hours obligation for this window — never
 * a replacement for `demandDrivenShiftsByDay`, which the caller must
 * merge this output on top of (a day already present in
 * `demandDrivenShiftsByDay` for an employee is left untouched here; this
 * function only ever ADDS a day that demand alone did not justify).
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

  const targetHoursThisWindow = proratedObligationHoursForWindow(config, daysOrder.length);
  if (targetHoursThisWindow === null) {
    // Obligation unconfirmed — pass-through, exactly today's behavior.
    return additional;
  }

  const flexiblePool = employees.filter(isFlexibleGeneralPool);
  const catalogCodes = shortestFirstCatalogCodes();
  // Never schedule below the confirmed OFF-day entitlement for this
  // displayed window, even to satisfy the obligation.
  const maxWorkingDaysThisWindow = Math.max(0, daysOrder.length - config.normal_weekly_off_days);

  for (const employee of flexiblePool) {
    const scheduledDays = new Set<string>(
      daysOrder.filter((d) => (demandDrivenShiftsByDay[d] ?? []).some((g) => g.employeeId === employee.id))
    );

    let scheduledHours = 0;
    for (const day of scheduledDays) {
      const g = (demandDrivenShiftsByDay[day] ?? []).find((x) => x.employeeId === employee.id)!;
      scheduledHours += getShiftDurationHours(g.shiftCode);
    }

    let shortfallHours = Math.max(0, targetHoursThisWindow - scheduledHours);
    if (shortfallHours <= 0) continue;

    let priorShift = priorWeekBoundaryContext.get(employee.id) ?? null;

    for (let i = 0; i < daysOrder.length && shortfallHours > 0; i++) {
      const day = daysOrder[i];

      if (scheduledDays.has(day)) {
        // Advance the rest-continuity walk through this REAL
        // demand-driven day (already legal, since it survived Stage 6's
        // own rest gate) before considering the next day.
        const g = (demandDrivenShiftsByDay[day] ?? []).find((x) => x.employeeId === employee.id)!;
        priorShift = getShiftTimesAs(g.shiftCode);
        continue;
      }

      if (scheduledDays.size >= maxWorkingDaysThisWindow) {
        // Adding more days would leave this employee below the confirmed
        // minimum OFF-day entitlement for this window — a genuine,
        // honest obligation shortfall, never overridden.
        break;
      }

      const legal = catalogCodes.find((c) => {
        if (!priorShift) return true;
        return restHoursBetween(priorShift.shift_start, priorShift.shift_end, minutesToTime(c.entreeMin)) >= minimumRestHours;
      });

      if (!legal) {
        // No legally-rested shift available today for this employee —
        // leave the day OFF, exactly the honest-gap convention used
        // everywhere else in this pipeline, and try the next day.
        priorShift = null; // an OFF day always resets rest fully
        continue;
      }

      additional[day].push({ employeeId: employee.id, dayOfWeek: day, shiftCode: legal.code, coversRoles: [] });
      scheduledDays.add(day);
      shortfallHours -= getShiftDurationHours(legal.code);
      priorShift = getShiftTimesAs(legal.code);
    }
  }

  return additional;
}
