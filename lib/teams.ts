import { CONFIGURED_COMPANIES } from "./company-config";

/**
 * SKILL vs ASSIGNMENT is the core distinction:
 * - Skill (Employee.skills) = a flight-task capability the employee is
 *   trained to perform (Boarding, Gate, Check-in, etc. — see
 *   lib/skill-groups.ts's ADDABLE_QUALIFICATION_GROUPS for the confirmed
 *   vocabulary).
 * - Assignment (Employee.assignment) = where the employee is CURRENTLY
 *   placed for weekly planning: an internal RAM service (this list) or a
 *   foreign company name (see company-config.ts). An employee's assignment
 *   can differ from what they're skilled at — e.g. someone Boarding-skilled
 *   can be currently assigned to Profiling, and their Boarding skill simply
 *   isn't in active use that week.
 *
 * Internal RAM services, with the operational descriptions provided:
 *  - General T1 Pool: general/unassigned — the default ACE pool, no
 *    specialized placement.
 *  - Transit: agents handling anything related to passengers transitioning
 *    through CMN. Committed for the full shift once clocked in (see
 *    isTransitTeam below) — no partial availability.
 *  - Profiling: document verification for transitioning passengers.
 *  - Mesure: inspecting carry-on baggage at the gate. Distinct from Weight
 *    Control (normal baggage-weight checking in T1).
 *  - Baggage Claim: baggage claim area — handles baggage claim and baggage
 *    loss matters.
 *  - Service Plus: T1-based premium/VIP/business-class/lounge activity.
 *  - Caisse/BCB: the payment desk.
 *  - Leaders / Duty Officers: specialized roles with fixed JR/NT-type
 *    planning (see shift-templates.ts) — never general ACE allocation.
 */
export const TEAMS = [
  "General T1 Pool",
  "Transit",
  "Profiling",
  "Mesure",
  "Baggage Claim",
  "Leaders",
  "Duty Officers",
  "Caisse/BCB",
  "Service Plus",
] as const;

export type Team = (typeof TEAMS)[number];

/**
 * Foreign-company work is deliberately NOT a permanent team — but it CAN
 * be an employee's current assignment for the week (Employee.assignment
 * equals a company name from company-config.ts), exactly like an internal
 * service assignment. What makes it non-permanent is operational, not
 * structural: outside a specific flight's protected window (see
 * foreign-company-window.ts), that employee is still available to RAM.
 * Being *assigned* there doesn't blanket-exclude them the way Transit or a
 * fixed-planning team does.
 */

/**
 * These teams follow fixed, specialized planning rather than general ACE
 * allocation — Atlas must never offer them as candidates for ordinary
 * flight-task recommendations. Leaders and Duty Officers now both use the
 * confirmed fixed cycle (see FIXED_CYCLE_TEAMS below); Caisse-BCB's real
 * rotation has still not been provided and is NOT modeled here — this
 * only encodes the exclusion, not an invented schedule.
 */
export const FIXED_PLANNING_TEAMS: Team[] = ["Leaders", "Duty Officers", "Caisse/BCB"];

export function isFixedPlanningTeam(assignment: string): boolean {
  return (FIXED_PLANNING_TEAMS as string[]).includes(assignment);
}

/**
 * Teams with a confirmed, continuous FIXED CYCLE rotation (see
 * lib/fixed-cycle-rotation.ts) rather than a flat per-week OFF-day count
 * or a demand-derived rotation. Currently: Transit, Leaders, and Duty
 * Officers, all sharing the one confirmed JR → NT → OFF → OFF cycle.
 *
 * Duty Officers moved here from a flat single-repeating-code template
 * (see the delivered specialized-team-roster milestone) precisely because
 * that flat template could never satisfy the confirmed 15h minimum rest
 * (JR01/NT01 repeated daily both yield only 11.5h) — the JR/NT/OFF/OFF
 * cycle is the one ALREADY-confirmed, ALREADY-proven-feasible pattern
 * that matches what Duty Officers is documented everywhere else as
 * wanting ("JR/NT-type planning"), so reusing it is a minimum structural
 * correction, not an invented new policy. The exact JR CODE convention
 * (JR01 vs JR02) for Duty Officers remains as unconfirmed as it is for
 * Leaders — see fixed-cycle-rotation.ts's own note on JR_NT_OFF_OFF_CYCLE.
 *
 * This list is planning CONFIGURATION, not part of the rotation engine
 * itself — the engine never branches on a team name; only this table
 * decides which teams use it. Used to keep the generic single-week
 * consecutive-OFF validator (lib/planning/consecutive-off.ts) from
 * misapplying a period-7 wraparound check to a period-4 continuous cycle
 * — these teams are validated directly against their cycle definition
 * instead.
 */
export const FIXED_CYCLE_TEAMS: Team[] = ["Transit", "Leaders", "Duty Officers"];

export function usesFixedCycleRotation(assignment: string): boolean {
  return (FIXED_CYCLE_TEAMS as string[]).includes(assignment);
}

/**
 * Transit is stricter than "fixed planning": Transit agents clock in and
 * remain in Transit for the entire shift. They must never appear as
 * candidates for any role other than Transit itself, for the duration of
 * their shift — there is no partial availability.
 */
export function isTransitTeam(assignment: string): boolean {
  return assignment === "Transit";
}

/**
 * The single, centralized list of operational placements an employee can
 * be assigned to — internal RAM teams and foreign companies together,
 * flat, exactly as an operator thinks about workforce groups (Employees
 * filtering and Add Employee both use this same list, so the two never
 * drift apart). Internally, TEAMS vs. company names are still distinct
 * concepts (see company-config.ts) — this list just presents them as one
 * understandable set of choices.
 */
export const OPERATIONAL_PLACEMENTS = [...TEAMS, ...CONFIGURED_COMPANIES];
