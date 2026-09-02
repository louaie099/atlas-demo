import { Employee } from "../types";
import { isFixedPlanningTeam, isTransitTeam } from "../teams";
import { CONFIGURED_COMPANIES } from "../company-config";

/**
 * Stage 3 of the planning pipeline: recognizing which employees are
 * NOT flexible RAM capacity before consuming anyone for flight coverage.
 * Reuses the exact same predicates already established (teams.ts,
 * company-config.ts) — no parallel "is this employee available" logic.
 */

/** Currently placed at a foreign company — protected by that company's real flight schedule (see foreign-shift-planning.ts), not general RAM capacity for planning purposes. */
export function isForeignCompanyAssigned(employee: Employee): boolean {
  return CONFIGURED_COMPANIES.includes(employee.assignment);
}

/** Leaders, Duty Officers, Caisse/BCB — fixed/specialized planning, never general ACE allocation. */
export function isFixedSpecializedTeam(employee: Employee): boolean {
  return isFixedPlanningTeam(employee.assignment);
}

/** Transit — committed for the full shift once on it, per the established domain rule. */
export function isTransitAssigned(employee: Employee): boolean {
  return isTransitTeam(employee.assignment);
}

/**
 * The flexible General T1 ACE pool: not foreign-committed, not on a fixed/
 * specialized team, not Transit, active, and not a Duty Officer. This is
 * who Stage 6 (shift generation) actually has to work with — everyone
 * else already has their placement determined by something other than
 * flight-by-flight RAM demand.
 */
export function isFlexibleGeneralPool(employee: Employee): boolean {
  return (
    employee.active &&
    !employee.is_duty_officer &&
    !isForeignCompanyAssigned(employee) &&
    !isFixedSpecializedTeam(employee) &&
    !isTransitAssigned(employee)
  );
}

/**
 * Profiling and Mesure assignment-holders are a distinct middle case per
 * the brief: not fully fixed like Transit/Leaders, but also not general
 * flexible capacity — their staffing should track flight-driven demand
 * once real rules exist (see specialized-demand.ts). Exposed separately
 * so callers don't have to reconstruct this classification themselves.
 */
export function isProfilingOrMesureAssigned(employee: Employee): boolean {
  return employee.assignment === "Profiling" || employee.assignment === "Mesure";
}
