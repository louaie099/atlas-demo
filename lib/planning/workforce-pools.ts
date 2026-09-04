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
 * Profiling and Mesure assignment-holders are a distinct middle case per
 * the brief: not fully fixed like Transit/Leaders, but also not general
 * flexible capacity — their staffing follows their own team's normal
 * roster, not generic Boarding/Check-in/Gate demand. Defined before
 * isFlexibleGeneralPool below (which now excludes them) so the ordering
 * reads top-down.
 */
export function isProfilingOrMesureAssigned(employee: Employee): boolean {
  return employee.assignment === "Profiling" || employee.assignment === "Mesure";
}

/**
 * The flexible General T1 ACE pool: not foreign-committed, not on a fixed/
 * specialized team, not Transit, not Profiling/Mesure-placed, active, and
 * not a Duty Officer. This is who Stage 6 (shift generation) actually has
 * to work with — everyone else already has their placement determined by
 * something other than generic flight-by-flight RAM demand.
 *
 * Profiling/Mesure exclusion is deliberate and distinct from qualification:
 * an employee whose CURRENT PLACEMENT is Profiling is planned around their
 * Profiling team's own roster, not pulled into ordinary Boarding/Gate/
 * Check-in shift generation just because they happen to hold a matching
 * skill. A General T1 Pool employee who happens to ALSO hold the
 * Profiling skill is unaffected — they're still flexible, and duty
 * generation (Stage 9) can still match them to Profiling demand directly
 * via their skill, exactly as the brief describes ("a General T1 ACE with
 * Profiling qualification can still be flexible").
 */
export function isFlexibleGeneralPool(employee: Employee): boolean {
  return (
    employee.active &&
    !employee.is_duty_officer &&
    !isForeignCompanyAssigned(employee) &&
    !isFixedSpecializedTeam(employee) &&
    !isTransitAssigned(employee) &&
    !isProfilingOrMesureAssigned(employee)
  );
}
